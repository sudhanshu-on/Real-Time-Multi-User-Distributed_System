import { protect } from "../middlewares/auth.middleware.js";
import {
  getDocs,
  createDoc,
  updateDoc,
  deleteDoc,
} from "../controllers/docs.controller.js";
import { Router } from "express";

const router = Router();

router.get("/", protect, getDocs);
router.post("/createdocs", protect, createDoc);
router.put("/updatedocs/:docId", protect, updateDoc);
router.delete("/deletedocs/:docId", protect, deleteDoc);

export default router;
