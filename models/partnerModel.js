import mongoose from "mongoose";

const PartnerSchema = new mongoose.Schema(
  {
    // e.g. "Acme Corp"
    title: {
      type: String,
      required: true,
      trim: true,
    },

    // e.g. "Technology Partner", "Used by", "Sponsor"
    designation: {
      type: String,
      trim: true,
      default: "",
    },

    // logo URL (uploaded somewhere or CDN link)
    logo: {
      type: String,
      required: true,
      trim: true,
    },

    // Optional: member since / partnered since
    memberSince: {
      type: Date,
    },

    // For hiding/showing on public "Partnered by / Used by" section
    isVisible: {
      type: Boolean,
      default: false, // 👈 start hidden
    },

    added_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Partner = mongoose.model("Partner", PartnerSchema);

export default Partner;
