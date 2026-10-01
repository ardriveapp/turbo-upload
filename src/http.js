"use strict";
// The transport lives in the core, which both builds share. This path is kept
// so nothing that required it before has to change.
module.exports = require("./core/http.js");
