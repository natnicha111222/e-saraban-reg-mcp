// ingest.js — อ่านไฟล์ PDF / Word (.docx) / Excel (.xlsx .xls) → chunk → embed → เก็บใน Qdrant
// รัน: node ingest.js <file>  หรือ  node ingest.js <directory>

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
const { QdrantClient } = require("@qdrant/qdrant-js");
const { embed } = require("./embed");

const QDRANT_URL  = process.env.QDRANT_URL  || "http://localhost:6333";
const COLLECTION  = process.env.QDRANT_COLLECTION || "regulations";
const CHUNK_SIZE  = 200;
const CHUNK_OVERLAP = 20;

const qdrant = new QdrantClient({ url: QDRANT_URL });
const SUPPORTED = [".pdf", ".docx", ".doc", ".xlsx", ".xls"];

// ── Text Cleaners ─────────────────────────────────────────────────────────────

function cleanText(text) {
  return text
    .replace(/[^฀-๿ -~\n\r\t]/g, " ")
    .replace(/([ก-๿]) ([ก-๿])/g, "$1$2")
    .replace(/([ก-๿]) ([ก-๿])/g, "$1$2")
    .replace(/([ก-๿]) ([ก-๿])/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([0-9])([ก-๿])/g, "$1 $2")
    .replace(/([ก-๿])([0-9])/g, "$1 $2")
    .trim();
}

// ── File Readers ──────────────────────────────────────────────────────────────

async function readPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parsed = await pdf(buffer);
  console.log(`  [PDF] pages: ${parsed.numpages}`);
  return cleanText(parsed.text);
}

async function readWord(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  console.log(`  [Word] extracted ${result.value.length} chars`);
  return cleanText(result.value);
}

function readExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  let text = "";
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!rows.length) return;
    text += `=== ${sheetName} ===\n`;
    rows.forEach(row => {
      text += Object.entries(row)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join(" | ");
      text += "\n";
    });
    text += "\n";
  });
  console.log(`  [Excel] sheets: ${workbook.SheetNames.length}`);
  return cleanText(text);
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf")                 return readPdf(filePath);
  if (ext === ".docx" || ext === ".doc") return readWord(filePath);
  if (ext === ".xlsx" || ext === ".xls") return readExcel(filePath);
  throw new Error(`ไม่รองรับไฟล์ ${ext}`);
}

// ── Chunking & Indexing ───────────────────────────────────────────────────────

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

async function ensureCollection(vectorSize) {
  const { collections } = await qdrant.getCollections();
  if (!collections.some(c => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: vectorSize, distance: "Cosine" }
    });
    console.log(`  ✓ Created collection: ${COLLECTION}`);
  }
}

async function ingestFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  console.log(`\nIngesting [${ext.slice(1).toUpperCase()}]: ${path.basename(filePath)}`);

  const text = await extractText(filePath);
  console.log(`  Clean text: ${text.length} chars`);

  const chunks = chunkText(text);
  console.log(`  Chunks: ${chunks.length}`);

  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Embedding ${i + 1}/${chunks.length}...\r`);
    const vector = await embed(chunks[i]);
    if (i === 0) await ensureCollection(vector.length);
    // deterministic id จากชื่อไฟล์ + chunk index → ingest ซ้ำจะ upsert ทับแทน ไม่ซ้ำกัน
    const idStr = `${path.basename(filePath)}::${i}`;
    const id = parseInt(crypto.createHash("md5").update(idStr).digest("hex").slice(0, 15), 16);
    points.push({
      id,
      vector,
      payload: { text: chunks[i], source: path.basename(filePath), chunkIndex: i, type: ext.slice(1) }
    });
  }

  await qdrant.upsert(COLLECTION, { points });
  console.log(`\n  ✓ Stored ${points.length} chunks`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(`Usage: node ingest.js <file|directory>\nSupported: ${SUPPORTED.join(", ")}`);
    process.exit(1);
  }

  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target)
        .filter(f => SUPPORTED.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(target, f))
    : [target];

  if (!files.length) {
    console.error(`No supported files found (${SUPPORTED.join(", ")})`);
    process.exit(1);
  }

  console.log(`Found ${files.length} file(s): ${files.map(f => path.basename(f)).join(", ")}`);
  for (const f of files) await ingestFile(f);
  console.log("\n✓ Ingest complete");
}

main().catch(console.error);
