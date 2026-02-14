/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_PDS_URL?: string;
	readonly VITE_AUTH_DOMAIN?: string;
	readonly VITE_AUTH_URI?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
