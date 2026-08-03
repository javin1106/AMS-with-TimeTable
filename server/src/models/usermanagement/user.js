const Mongoose = require("mongoose");
require('../commonFields');
const UserSchema = new Mongoose.Schema({
  name: {
    type: String,
  },
  role: {
    type: [String],
    required: true,
  },
  password: {
    type: String,
    required: true,
  }, 
  profession: {type: String},
  dept: {
    type: String,
    trim: true,
    default: "",
  },
  // Additional department scopes shown only in Ground Truth Acquisition and
  // Roll Assignment. `dept` remains the user's primary/dashboard department.
  attendanceDepartments: [{
    type: String,
    trim: true,
  }],
  email: [{
    type: String,
    required: true,
  }],
  area:[{type: String}],
  isEmailVerified:{
    type : Boolean,
  },
  isFirstLogin:{
    type : Boolean,
  },
  researchArea:[{type: String}],
  uploads:[{type: String}],
});
const User = Mongoose.model("user", UserSchema);
module.exports = User;
