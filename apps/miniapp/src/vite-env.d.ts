/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_PDS_DOMAIN?: string;
	readonly VITE_AUTH_DOMAIN?: string;
	readonly VITE_AUTH_URI?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
