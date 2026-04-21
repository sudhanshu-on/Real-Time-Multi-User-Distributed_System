import ratelimit from "express-rate-limit";

const limiter = ratelimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again after 15 minutes"
});

const authLimiter = ratelimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: "Too many login attempts from this IP, please try again after 15 minutes"
});

export { limiter, authLimiter };