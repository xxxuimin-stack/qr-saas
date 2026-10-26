// Firebase Storage, loaded only when something is uploaded (keeps the customer menu page lighter on mobile data).
import { getStorage, connectStorageEmulator, ref, uploadBytes, uploadBytesResumable, uploadString, getDownloadURL } from "firebase/storage";
import { app } from "./firebase.js";

export const storage = getStorage(app);
if (import.meta.env.VITE_USE_EMULATOR === "true") connectStorageEmulator(storage, "127.0.0.1", 9199);
export { ref, uploadBytes, uploadBytesResumable, uploadString, getDownloadURL };
