require("dotenv").config();

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// เรียก Ollama embedding API โดยตรง ไม่ต้องใช้ LangChain
async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text })
  });
  const data = await res.json();
  return data.embeddings?.[0] || data.embedding;
}

module.exports = { embed };
