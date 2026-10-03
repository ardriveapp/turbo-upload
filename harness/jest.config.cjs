// Jest with its jsdom environment, which is how a browser app is usually unit
// tested. jest-environment-jsdom resolves packages with the `browser`
// condition, so this proves the condition picks the web build there too.
module.exports = {
  testEnvironment: "jsdom",
  roots: ["<rootDir>/jest"],
  testMatch: ["**/*.test.cjs"],
};
