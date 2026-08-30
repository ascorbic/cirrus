// Test fixture types - the bindings provided to the fixture worker
import type {
	TestSpaceDurableObject,
	TestSpaceIndexDurableObject,
} from "./index";

declare global {
	interface Env {
		SPACES: DurableObjectNamespace<TestSpaceDurableObject>;
		SPACES_INDEX: DurableObjectNamespace<TestSpaceIndexDurableObject>;
		BLOBS: R2Bucket;
	}
}
