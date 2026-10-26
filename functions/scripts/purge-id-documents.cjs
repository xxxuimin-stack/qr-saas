/**
 * One-off cleanup for identity-document uploads and references.
 *
 * SAFETY: dry-run by default. Run with both flags only after confirming the target Firebase project:
 *   FIREBASE_STORAGE_BUCKET=<project>.appspot.com node functions/scripts/purge-id-documents.cjs --execute --confirm=DELETE-ID-DOCUMENTS
 *
 * Does NOT delete the entire private/ folder. Payment proofs, signed waivers/signatures, incident
 * photos, staff PIN data, API tokens, and other unrelated private files are preserved.
 */
const admin = require("firebase-admin");
const { FieldPath, FieldValue } = require("firebase-admin/firestore");

const execute = process.argv.includes("--execute") &&
  process.argv.includes("--confirm=DELETE-ID-DOCUMENTS");
const config = (() => {
  try { return JSON.parse(process.env.FIREBASE_CONFIG || "{}"); }
  catch { return {}; }
})();
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || config.storageBucket;
if (!bucketName) {
  console.error("Set FIREBASE_STORAGE_BUCKET to the exact Firebase Storage bucket before running this cleanup.");
  process.exit(2);
}
if (!admin.apps.length) {
  admin.initializeApp({
    ...(config.projectId || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT
      ? { projectId: config.projectId || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT }
      : {}),
    storageBucket: bucketName,
  });
}
const db = admin.firestore();
const bucket = admin.storage().bucket(bucketName);

const ID_FIELDS = new Set([
  "idUrl", "idPhotoUrl", "idPhoto", "idImageUrl", "homeIdUrl", "guestIds",
  "validIdUrl", "validIdPhotoUrl", "validIdImageUrl",
  "identityDocumentUrl", "identityDocument", "idDocumentUrl", "governmentIdUrl",
  "governmentIdPhotoUrl", "idFrontUrl", "idBackUrl", "passportPhotoUrl", "passportUrl",
  "permitUrl", "permitPhoto", "permitImageUrl", "permitFileUrl", "businessPermit",
  "businessPermitUrl", "mayorsPermit", "mayorsPermitUrl", "permitPhotoUrl", "permitDocumentUrl",
  "idNumber", "idType", "idExpiry", "idExpiration", "passportNumber", "permitNumber",
]);
const ID_META_FIELDS = new Set(["homeIdAt", "needsIdOk", "noId", "kycAt", "idUploadedAt", "idVerifiedAt", "idDocumentAt"]);
const objectPaths = new Set();
const patchesByPath = new Map();
const kycDocsToDelete = new Set();
let documentsScanned = 0;
let documentsToChange = 0;
let privateObjectsScanned = 0;
let objectsToDelete = 0;

function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function parsePrivateObjectPath(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("priv:")) candidate = candidate.slice(5);
  else if (candidate.startsWith("gs://")) {
    const rest = candidate.slice(5);
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    candidate = rest.slice(slash + 1);
  } else if (/^https?:\/\//i.test(candidate)) {
    try {
      const u = new URL(candidate);
      const marker = "/o/";
      const i = u.pathname.indexOf(marker);
      if (i < 0) return null;
      candidate = decodeURIComponent(u.pathname.slice(i + marker.length));
    } catch { return null; }
  }
  if (!candidate.startsWith("stores/") || !candidate.includes("/private/") ||
      candidate.includes("..") || candidate.includes("?") || candidate.includes("#")) return null;
  return candidate;
}

function collectPrivatePaths(value) {
  if (typeof value === "string") {
    const p = parsePrivateObjectPath(value);
    if (p) objectPaths.add(p);
  } else if (Array.isArray(value)) {
    for (const v of value) collectPrivatePaths(v);
  } else if (isPlainObject(value)) {
    for (const v of Object.values(value)) collectPrivatePaths(v);
  }
}

function addPatch(path, fieldSegments, value = FieldValue.delete()) {
  if (!patchesByPath.has(path)) patchesByPath.set(path, new Map());
  patchesByPath.get(path).set(JSON.stringify(fieldSegments), { fieldSegments, value });
}

function stripIdFieldsFromArrayValue(value) {
  if (!isPlainObject(value)) return { value, changed: false };
  const out = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (ID_FIELDS.has(key)) {
      collectPrivatePaths(child);
      changed = true;
    } else if (ID_META_FIELDS.has(key)) {
      changed = true;
    } else if (Array.isArray(child)) {
      const items = child.map(stripIdFieldsFromArrayValue);
      if (items.some((x) => x.changed)) {
        out[key] = items.map((x) => x.value);
        changed = true;
      } else out[key] = child;
    } else if (isPlainObject(child)) {
      const nested = stripIdFieldsFromArrayValue(child);
      out[key] = nested.value;
      changed = changed || nested.changed;
    } else out[key] = child;
  }
  return { value: out, changed };
}
function inspectMap(value, path, segments = []) {
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...segments, key];
    if (ID_FIELDS.has(key)) {
      collectPrivatePaths(child);
      addPatch(path, next);
      continue;
    }
    if (ID_META_FIELDS.has(key)) {
      addPatch(path, next);
      continue;
    }
    if (Array.isArray(child)) {
      const items = child.map(stripIdFieldsFromArrayValue);
      if (items.some((x) => x.changed)) addPatch(path, next, items.map((x) => x.value));
    } else if (isPlainObject(child)) inspectMap(child, path, next);
  }
}

function addKnownSettingsPatches(doc) {
  if (doc.ref.path.split("/").length !== 2) return;
  const data = doc.data() || {};
  const settings = data.settings || {};
  if (settings.stay && typeof settings.stay === "object") {
    addPatch(doc.ref.path, ["settings", "stay", "requireId"], false);
    addPatch(doc.ref.path, ["settings", "stay", "guestIds"], false);
    addPatch(doc.ref.path, ["settings", "stay", "noIdOk"], true);
  }
  if (settings.salon && settings.salon.homeService && typeof settings.salon.homeService === "object") {
    addPatch(doc.ref.path, ["settings", "salon", "homeService", "requireId"], false);
  }
  if (settings.salon && settings.salon.freelance && typeof settings.salon.freelance === "object") {
    addPatch(doc.ref.path, ["settings", "salon", "freelance", "requireIdOnSite"], false);
  }
  if (settings.waiver && typeof settings.waiver === "object") {
    addPatch(doc.ref.path, ["settings", "waiver", "idMode"], "off");
  }
}

async function scanDocument(doc) {
  documentsScanned++;
  const data = doc.data() || {};
  const isKycDoc = /\/private\/kyc$/.test(doc.ref.path);
  if (isKycDoc) {
    collectPrivatePaths(data);
    kycDocsToDelete.add(doc.ref.path);
  }
  inspectMap(data, doc.ref.path);
  if (doc.ref.path.startsWith("stores/") && doc.ref.path.split("/").length === 2) addKnownSettingsPatches(doc);
  const subs = await doc.ref.listCollections();
  for (const col of subs) await scanCollection(col);
}

async function scanCollection(collectionRef) {
  const snap = await collectionRef.get();
  for (const doc of snap.docs) await scanDocument(doc);
}

function matchesKnownIdentityFilename(objectName) {
  if (!objectName.includes("/private/")) return false;
  const name = objectName.split("/").pop() || "";
  return /(?:kyc|home-id|inqid_|(?:^|[-_])id(?:[-_]|\.|$)|permit)/i.test(name) &&
    /\.(?:jpg|jpeg|png|webp|pdf)$/i.test(name);
}

async function main() {
  console.log("Mode: " + (execute ? "EXECUTE DELETE" : "DRY RUN (no changes)"));
  console.log("Project: " + (config.projectId || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "(from credentials)"));
  console.log("Storage bucket: " + bucketName);
  const topLevel = await db.listCollections();
  for (const col of topLevel) await scanCollection(col);

  // Known named-ID patterns may not have an active Firestore reference anymore.
  const storeSnap = await db.collection("stores").get();
  const namedFiles = [];
  for (const store of storeSnap.docs) {
    const [files] = await bucket.getFiles({ prefix: "stores/" + store.id + "/private/" });
    privateObjectsScanned += files.length;
    for (const file of files) {
      if (matchesKnownIdentityFilename(file.name)) namedFiles.push(file.name);
    }
  }
  for (const name of namedFiles) objectPaths.add(name);

  const objectNames = [...objectPaths].filter((p) => p.startsWith("stores/") && p.includes("/private/") && !p.includes(".."));
  objectsToDelete = objectNames.length;
  for (const [path, fields] of patchesByPath) {
    const doc = db.doc(path);
    const args = [];
    for (const { fieldSegments, value } of fields.values()) {
      args.push(new FieldPath(...fieldSegments), value);
    }
    if (execute && args.length) await doc.update(...args);
    if (fields.size) documentsToChange++;
  }
  if (execute) {
    for (const path of kycDocsToDelete) await db.doc(path).delete().catch((e) => {
      if (e.code !== 5) throw e;
    });
    let deleted = 0;
    for (const path of objectNames) {
      await bucket.file(path).delete({ ignoreNotFound: true });
      deleted++;
    }
    console.log("Deleted private ID/permit objects: " + deleted);
    console.log("Deleted old KYC documents: " + kycDocsToDelete.size);
    console.log("Sanitized Firestore documents: " + documentsToChange);
  } else {
    console.log("Would delete private ID/permit objects: " + objectsToDelete);
    console.log("Would delete old KYC documents: " + kycDocsToDelete.size);
    console.log("Would sanitize Firestore documents: " + documentsToChange);
    console.log("Re-run with --execute --confirm=DELETE-ID-DOCUMENTS only after checking the project and dry-run counts.");
  }
  console.log("Documents scanned: " + documentsScanned);
  console.log("Private objects inspected: " + privateObjectsScanned);
}

main().catch((err) => {
  console.error("Identity-document cleanup failed:", err.message || err);
  process.exitCode = 1;
});
