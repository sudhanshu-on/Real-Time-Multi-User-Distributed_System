import mongoose from "mongoose";

const projectMemberSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    projectId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
        required: true
    }
}, {
    timestamps: true
});

export const ProjectMember = mongoose.model("ProjectMember", projectMemberSchema);