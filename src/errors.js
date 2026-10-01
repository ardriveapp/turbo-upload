"use strict";
// The error classes live in the core, which both builds share. This path is
// kept so nothing that required it before has to change.
module.exports = require("./core/errors.js");
