import User from "../models/user.js";

const userProfile = async (req, res) => {
  try {
    // const { id } = req.params;
    // console.log(req.user);

    const user = await User.findById(req.user._id)
      .select(
        "-password -OTP_code -isAdmin -is_verified -is_active -otp -stripeCustomerId"
      )
      .lean();

    if (!user) {
      return res.status(400).json({ message: "user not found" });
    }
    delete user.password;
    res.status(200).json({ user: user });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ message: "No data provided" });
    }

    // Disallow sensitive fields
    const disallowedFields = [
      "_id",
      "email",
      "password",
      "isAdmin",
      "is_verified",
      "is_active",
      "otp",
      "stripeCustomerId",
    ];
    const sanitizedBody = {};

    // Only allow valid fields
    Object.keys(req.body).forEach((key) => {
      if (!disallowedFields.includes(key)) {
        sanitizedBody[key] = req.body[key];
      }
    });

    // console.log(sanitizedBody.address);
    // // Parse address if it's a string
    // if (typeof sanitizedBody.address === "string") {
    //   try {
    //     sanitizedBody.address = JSON.parse(sanitizedBody.address);
    //   } catch {
    //     return res.status(400).json({ message: "Invalid address format" });
    //   }
    // }

    if (req.file) {
      sanitizedBody.image = req.file.path;
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      sanitizedBody,
      {
        new: true,
        runValidators: true,
      }
    );

    const { isAdmin, isPaid, OTP_code, isSuspended, ...safeUser } =
      updatedUser.toObject();
    res.status(200).json({
      message: "User profile updated successfully",
      user: safeUser,
    });
  } catch (error) {
    console.error("Update profile error:", error.message);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const setUserRole = async (req, res) => {
  try {
    const { userId, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({ message: "User ID and role are required" });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.userRole = role;
    await user.save();

    res
      .status(200)
      .json({ success: true, message: "User role updated successfully", user });
  } catch (error) {
    console.error("Error updating user role:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// View all users
export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({});
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

// View specific user
export const getUserById = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.userId });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
};

// Suspend or unsuspend user
export const suspendUser = async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.params.userId },
      { isSuspended: req.body.suspend },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      message: `User ${req.body.suspend ? "suspended" : "unsuspended"}`,
      user,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to update user suspension" });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ _id: req.params.userId });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
};
export { userProfile, updateProfile };
