import { signin, signup, logout } from "../controllers/auth.controller.js";
import { authLimiter } from "../middlewares/ratelimiting.middleware.js";
import { Router } from 'express';

const router = Router();

router.post('/signup', authLimiter, signup);
router.post('/signin', authLimiter, signin);
router.post('/logout', authLimiter, logout);

export default router;