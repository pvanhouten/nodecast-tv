const { discoverOidcEndpoints } = require('./services/oidcDiscovery');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { Strategy: LocalStrategy } = require('passport-local');
const security = require('./config/security');
const authTokens = require('./services/authTokens');
const crypto = require('node:crypto');

/**
 * Authentication and Authorization Module
 * Handles user authentication, session management, and role-based access control
 * Using Passport.js with JWT tokens
 */

// JWT Secret - In production, use environment variable
const JWT_SECRET = security.jwtSecret;

// How long a browser login lasts. AUTH_SESSION_DAYS (1-365) lengthens it; when it is set, a login that is used
// is also renewed once it is past half of its lifetime, so regular use never hits the limit. Unset = 24 h, no renewal.
function sessionSettings(env = process.env) {
    const raw = env.AUTH_SESSION_DAYS;
    const days = Number(raw);
    const custom = raw !== undefined && raw !== '' && Number.isFinite(days) && days >= 1 && days <= 365;
    const seconds = Math.round((custom ? days : 1) * 24 * 60 * 60);
    return { seconds, renew: custom };
}
const SESSION = sessionSettings();
const JWT_EXPIRY = SESSION.seconds;

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || typeof hash !== 'string') return false;
    return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            authVersion: user.authVersion || 0,
            kind: 'access'
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY, algorithm: 'HS256', audience: 'nodecast-tv', jwtid: crypto.randomUUID() }
    );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    try {
        const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'nodecast-tv' });
        return payload.kind === 'access' && typeof payload.jti === 'string' ? payload : null;
    } catch (err) {
        return null;
    }
}

/**
 * Configure Passport Local Strategy for username/password authentication
 */
function configureLocalStrategy(getUserByUsername, verifyUserPassword) {
    passport.use(new LocalStrategy(
        async (username, password, done) => {
            try {
                const user = await getUserByUsername(username);

                if (!user || !user.passwordHash) {
                    // No local password on file (e.g. an OIDC-only, JIT-provisioned
                    // account) - fail the same way as an unknown user instead of
                    // handing bcrypt a null hash, which throws.
                    return done(null, false, { message: 'Invalid credentials' });
                }

                const isValid = await verifyUserPassword(password, user.passwordHash);

                if (!isValid) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }
    ));
}

/**
 * Configure Passport JWT Strategy for token-based authentication
 */
function configureJwtStrategy(getUserById) {
    const options = {
        jwtFromRequest: extractToken,
        secretOrKey: JWT_SECRET,
        algorithms: ['HS256'],
        audience: 'nodecast-tv'
    };

    passport.use(new JwtStrategy(options, async (payload, done) => {
        try {
            const user = await getUserById(payload.id);

            if (!user || payload.kind !== 'access' || typeof payload.jti !== 'string'
                || (payload.authVersion || 0) !== (user.authVersion || 0) || authTokens.isRevoked(payload)) {
                return done(null, false);
            }

            return done(null, {
                id: user.id,
                username: user.username,
                role: user.role
            });
        } catch (err) {
            return done(err, false);
        }
    }));
}

/**
 * Configure Passport session serialization
 * Required for OIDC flow which uses sessions
 */
function configureSessionSerialization(getUserById) {
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    });
}

/**
 * Configure Passport OpenID Connect Strategy
 */
async function configureOidcStrategy(findUserByOidcId, findUserByEmail, createUser) {
    if (!process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
        console.warn('OIDC configuration missing - SSO disabled');
        return false;
    }

    const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');

    const endpoints = await discoverOidcEndpoints(process.env);
    passport.use(new OpenIDConnectStrategy({
        ...endpoints,
        clientID: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        callbackURL: process.env.OIDC_CALLBACK_URL || '/api/auth/oidc/callback',
        scope: ['openid', 'profile', 'email']
    },
        async (...args) => {
            // The done callback is always the last argument
            const done = args[args.length - 1];

            // Map known arguments
            // Standard: issuer, sub, profile, accessToken, refreshToken, done
            // Some versions: issuer, sub, profile, accessToken, refreshToken, params, done

            let issuer, sub, profile;

            if (args.length === 3) {
                // Scenario: (issuer, profile, done)
                const arg0 = args[0];
                const arg1 = args[1];

                if (typeof arg1 === 'object' && arg1.id) {
                    issuer = arg0;
                    profile = arg1;
                    sub = profile.id;
                } else if (typeof arg0 === 'string' && typeof arg1 === 'string') {
                    issuer = arg0;
                    sub = arg1;
                    profile = { id: sub, displayName: 'Unknown' };
                }
            } else if (args.length >= 4) {
                // Assume standard: iss, sub, profile...
                issuer = args[0];
                sub = args[1];
                profile = args[2];
            }

            if (!sub && profile && profile.id) sub = profile.id;

            if (!sub) {
                return done(new Error('Could not identify OIDC Subject (sub) from arguments'));
            }

            try {
                // 1. Try to find by OIDC ID (sub)
                let user = await findUserByOidcId(sub);

                // 2. If not found, try to match by email
                // Extract email - handle both profile.emails[] (Google) and profile.email (others)
                const email = profile.emails?.[0]?.value || profile.email || profile._json?.email;

                if (!user && email && profile?._json?.email_verified === true) {
                    user = await findUserByEmail(email);

                    // If found by email but no OIDC ID, link them
                    if (user && !user.oidcId) {
                        // We don't have a direct update method for specific fields without full user object in this context
                        // Ideally we'd update the user here. For now, we'll just log in.
                        // Future: Update user with oidcId
                    }
                }

                // 3. If still not found, create new user (JIT Provisioning)
                if (!user) {
                    const username = profile.username || profile.displayName || (email ? email.split('@')[0] : `user_${sub.substring(0, 8)}`);

                    user = await createUser({
                        username: username,
                        role: 'viewer', // Default role for SSO users
                        oidcId: sub,
                        email: email || null
                    });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }));
    return true;
}

/**
 * Middleware: Require authentication using Passport JWT
 */
function requireAuth(req, res, next) {
    if (req.authenticatedUser) { req.user = req.authenticatedUser; return next(); }
    passport.authenticate('jwt', { session: false }, (error, user) => {
        if (error) return next(error);
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.user = req.authenticatedUser = user;
        renewCookieToken(req, res);
        next();
    })(req, res, next);
}

// Sliding session (only with AUTH_SESSION_DAYS set): hand a browser a fresh token once its cookie is past half-life.
function renewCookieToken(req, res, now = Date.now() / 1000) {
    if (!SESSION.renew || ExtractJwt.fromAuthHeaderAsBearerToken()(req) || res.headersSent) return;
    const token = extractToken(req);
    const old = token && jwt.decode(token);
    if (!old || !old.exp || !old.iat || old.kind !== 'access') return;
    if (old.exp - now > (old.exp - old.iat) / 2) return;
    const fresh = jwt.sign({ id: old.id, username: old.username, role: old.role, authVersion: old.authVersion || 0, kind: 'access' },
        JWT_SECRET, { expiresIn: JWT_EXPIRY, algorithm: 'HS256', audience: 'nodecast-tv', jwtid: crypto.randomUUID() });
    setAuthCookie(req, res, fresh);
}

function extractToken(req) {
    const bearer = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (bearer) return bearer;
    for (const part of (req.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (part.slice(0, separator).trim() === security.authCookieName) {
            try { return decodeURIComponent(part.slice(separator + 1)); } catch { return null; }
        }
    }
    return null;
}

function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'lax', secure: process.env.AUTH_COOKIE_SECURE === 'true'
        || (process.env.AUTH_COOKIE_SECURE !== 'false' && Boolean(req.secure)), path: '/' };
}
function setAuthCookie(req, res, token) {
    res.cookie(security.authCookieName, token, { ...cookieOptions(req), maxAge: SESSION.seconds * 1000 });
}
function clearAuthCookie(req, res) {
    res.clearCookie(security.authCookieName, cookieOptions(req));
}
function requireSameOrigin(req, res, next) {
    if (req.path.startsWith('/auth/oidc/')) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked' });
    const origin = req.get('origin') || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? req.get('referer') : null);
    if (!origin) return next(); // Non-browser API clients still require authentication.
    try {
        const allowed = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin
            : new URL(`${req.protocol}://${req.get('host')}`).origin;
        if (new URL(origin).origin === allowed) return next();
    } catch { /* Invalid origins are rejected. */ }
    res.status(403).json({ error: 'Cross-site request blocked' });
}

/**
 * Middleware: Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }
    next();
}

/**
 * Middleware: Check for specific role
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Forbidden - ${role} access required` });
        }
        next();
    };
}

module.exports = {
    passport,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    configureLocalStrategy,
    configureJwtStrategy,
    configureSessionSerialization,
    configureOidcStrategy,
    requireAuth,
    sessionSettings,
    renewCookieToken,
    extractToken,
    setAuthCookie,
    clearAuthCookie,
    requireSameOrigin,
    requireAdmin,
    requireRole
};
