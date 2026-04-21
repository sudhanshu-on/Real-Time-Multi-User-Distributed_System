import jwt from "jsonwebtoken";
import asynchandler from "express-async-handler";
import User from "../models/user.models.js";
import ApiError from "../utils/apiError.utils.js";

const protect = asynchandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.token;
  let token = cookieToken;

  if (!token && authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token) {
    throw new ApiError(401, "Authorization token missing or invalid");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      throw new ApiError(401, "User associated with token no longer exists");
    }

    req.user = user;
    next();
  } catch (_error) {
    throw new ApiError(401, "Not authorized, token failed");
  }
});

export { protect };