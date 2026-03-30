import {
	signin,
	signup,
	logout,
	getCurrentUser,
} from "../controllers/auth.controller.js";
import { authLimiter } from "../middlewares/ratelimiting.middleware.js";
import { protect } from "../middlewares/auth.middleware.js";
import { Router } from 'express';

const router = Router();

router.post('/signup', authLimiter, signup);
router.post('/signin', authLimiter, signin);
router.post('/logout', authLimiter, logout);
router.get('/me', protect, getCurrentUser);

export default router;