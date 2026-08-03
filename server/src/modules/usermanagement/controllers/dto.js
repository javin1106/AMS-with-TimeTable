const express = require("express");
const router = express.Router();

const User = require("../../../models/usermanagement/user");
const {
  getFacultyDepartmentByEmail,
} = require("./facultyDepartment");

const normalizeDepartment = (value) =>
  String(value || "").trim().replace(/[\s_-]+/g, "").toUpperCase();

const getAssignedDepartments = (user, primaryDepartment) => {
  const values = [
    primaryDepartment,
    ...(Array.isArray(user.attendanceDepartments)
      ? user.attendanceDepartments
      : []),
  ];
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeDepartment(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

// Function to get user details based on the user ID
async function getUserDetails(userId) {
  try {
    const user = await User.findById(userId);

    if (!user) {
      return null; // User not found
    }

    const department = user.dept?.trim()
      || await getFacultyDepartmentByEmail(user.email);
    const userDetails = {
      email: user.email,
      role: user.role,
      id: user.id,
      department,
      departments: getAssignedDepartments(user, department),
    };

    return userDetails;
  } catch (error) {
    throw error;
  }
}

module.exports = getUserDetails;
