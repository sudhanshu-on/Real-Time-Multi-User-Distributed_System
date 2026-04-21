import asynchandler from "express-async-handler";
import User from "../models/user.models.js";
import Document from "../models/docs.models.js";
import ApiResponse from "../utils/apiResponse.utils.js";
import ApiError from "../utils/apiError.utils.js";

const getDocs = asynchandler(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const docs = await Document.find({
    $or: [{ owner: userId }, { collaborators: userId }],
  })
    .populate("owner", "_id name email avatar")
    .populate("collaborators", "_id name email avatar")
    .sort({ createdAt: -1 });

  res
    .status(200)
    .json(new ApiResponse(true, "Documents retrieved successfully", docs));
});

const createDoc = asynchandler(async (req, res) => {
  const userId = req.user._id;
  const { name, description, content } = req.body;
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (!name || !name.trim()) {
    throw new ApiError(400, "Document name is required");
  }

  const newDoc = new Document({
    name: name.trim(),
    description: description || "",
    content: content || "",
    owner: userId,
    version: 0,
  });

  await newDoc.save();

  res
    .status(201)
    .json(new ApiResponse(true, "Document created successfully", newDoc));
});

const addCollaborator = asynchandler(async (req, res) => {
  const userId = req.user._id;
  const { docId } = req.params;
  const { collaboratorEmail } = req.body;
  const doc = await Document.findById(docId);
  if (!doc) {
    throw new ApiError(404, "Document not found");
  }
  if (doc.owner.toString() !== userId.toString()) {
    throw new ApiError(
      403,
      "You do not have permission to add collaborators to this document",
    );
  }
  const collaborator = await User.findOne({ email: collaboratorEmail });
  if (!collaborator) {
    throw new ApiError(404, "Collaborator not found");
  }
  if (
    doc.collaborators.some(
      (collaboratorId) =>
        collaboratorId.toString() === collaborator._id.toString(),
    )
  ) {
    throw new ApiError(400, "User is already a collaborator");
  }

  doc.collaborators.push(collaborator._id);
  await doc.save();

  const updatedDoc = await Document.findById(doc._id)
    .populate("owner", "_id name email avatar")
    .populate("collaborators", "_id name email avatar");

  return res
    .status(200)
    .json(new ApiResponse(true, "Collaborator added successfully", updatedDoc));
});

const updateDoc = asynchandler(async (req, res) => {
  const userId = req.user._id;
  const { docId } = req.params;
  const { name, description, content, version: expectedVersion } = req.body;
  const doc = await Document.findById(docId);
  if (!doc) {
    throw new ApiError(404, "Document not found");
  }
  const isOwner = doc.owner.toString() === userId.toString();
  const isCollaborator = doc.collaborators.some(
    (collaboratorId) => collaboratorId.toString() === userId.toString(),
  );

  if (!isOwner && !isCollaborator) {
    throw new ApiError(403, "Access denied");
  }
  const hasNameUpdate = typeof name === "string" && name.trim();
  const hasDescriptionUpdate = typeof description === "string";
  const hasContentUpdate = typeof content === "string";

  if (!hasNameUpdate && !hasDescriptionUpdate && !hasContentUpdate) {
    throw new ApiError(
      400,
      "At least one field (name, description, content) is required",
    );
  }

  if (expectedVersion === undefined) {
    throw new ApiError(400, "Version is required for update");
  }

  const parsedExpectedVersion = Number(expectedVersion);
  if (!Number.isInteger(parsedExpectedVersion) || parsedExpectedVersion < 0) {
    throw new ApiError(400, "Version must be a non-negative integer");
  }

  const updates = {};

  if (name && name.trim()) {
    updates.name = name.trim();
  }
  if (typeof description === "string") {
    updates.description = description;
  }
  if (typeof content === "string") {
    updates.content = content;
  }

  const updatedDoc = await Document.findOneAndUpdate(
    {
      _id: docId,
      $or: [{ owner: userId }, { collaborators: userId }],
      version: parsedExpectedVersion,
    },
    {
      $set: updates,
      $inc: { version: 1 },
    },
    { new: true },
  );

  if (!updatedDoc) {
    throw new ApiError(409, "Version conflict. Please refresh and retry.");
  }

  res
    .status(200)
    .json(new ApiResponse(true, "Document updated successfully", updatedDoc));
});

const deleteDoc = asynchandler(async (req, res) => {
  const userId = req.user._id;
  const { docId } = req.params;
  const doc = await Document.findById(docId);
  if (!doc) {
    throw new ApiError(404, "Document not found");
  }
  if (doc.owner.toString() !== userId.toString()) {
    throw new ApiError(
      403,
      "You do not have permission to delete this document",
    );
  }

  await Document.findByIdAndDelete(docId);

  res.status(200).json(new ApiResponse(true, "Document deleted successfully"));
});

export { getDocs, createDoc, addCollaborator, updateDoc, deleteDoc };
