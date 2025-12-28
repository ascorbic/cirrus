// Test fixture types - extends PDSEnv from the library
import type { PDSEnv } from "../../../src/types";

declare global {
	interface Env extends PDSEnv {}
}
