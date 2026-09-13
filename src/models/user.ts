/**
 * Backward-compatibility entry point for UserModel.
 * Re-exports the modular UserModel facade and sub-modules from ./user/index.
 *
 * @see ./user/index.ts
 */
export * from "./user/index";
export { UserModel } from "./user/index";
