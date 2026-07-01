require("dotenv").config();
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { QdrantClient } = require("@qdrant/qdrant-js");
const { z } = require("zod");
const { embed } = require("./embed");

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION || "regulations";
const PORT = process.env.MCP_PORT || 3003;

const qdrant = new QdrantClient({ url: QDRANT_URL });

const server = new McpServer({ name: "reg-mcp", version: "1.0.0" });

// ── RAG Tool ──────────────────────────────────────────────────────────────────

server.tool(
  "search_regulations",
  "ค้นหาข้อมูลจากเอกสารที่อัปโหลดเข้าระบบ ต้องเรียกสำหรับทุกคำถามที่ต้องการข้อมูล ห้ามตอบโดยไม่เรียก tool นี้ก่อน",
  {
    query: z.any().describe("คำถามหรือหัวข้อที่ต้องการค้นหาในระเบียบ"),
    topK: z.any().optional().describe("จำนวน chunks ที่ต้องการ (default: 3)"),
    token: z.any().optional()  // รับ token ที่ inject มาจาก AiService แต่ไม่ใช้ (Qdrant ไม่ต้องการ auth)
  },
  async (rawArgs) => {
    const q = String(rawArgs?.query || "");
    const k = Number(rawArgs?.topK) || 3;
    try {
      console.log(`\n[RAG] ════ search_regulations called ════`);
      console.log(`[RAG] query: "${q}" | topK: ${k}`);

      const vector = await embed(q);
      console.log(`[RAG] embedded query → ${vector.length} dims`);

      const results = await qdrant.search(COLLECTION, {
        vector, limit: k, with_payload: true
      });
      console.log(`[RAG] Qdrant returned ${results.length} results`);
      results.forEach((r, i) =>
        console.log(`[RAG] #${i + 1} score=${r.score?.toFixed(3)} src=${r.payload?.source} chunk=${r.payload?.chunkIndex}`)
      );

      if (!results.length) {
        console.log(`[RAG] no results found`);
        return { content: [{ type: "text", text: "ไม่พบข้อมูลในระเบียบที่เกี่ยวข้อง" }] };
      }

      const text = results.map((r, i) =>
        `[${i + 1}] จาก: ${r.payload.source} (chunk ${r.payload.chunkIndex})\n${r.payload.text}`
      ).join("\n\n---\n\n");

      console.log(`[RAG] ════ done ════\n`);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      console.error("[RAG] error:", err.message);
      return { content: [{ type: "text", text: `ค้นหาไม่สำเร็จ: ${err.message}` }] };
    }
  }
);

// ── HTTP/SSE Server ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const sessions = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions[transport.sessionId] = transport;
  console.log(`[MCP] client connected: ${transport.sessionId}`);
  res.on("close", () => {
    console.log(`[MCP] client disconnected: ${transport.sessionId}`);
    delete sessions[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const transport = sessions[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: "session not found" });
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_, res) => res.json({ status: "ok", qdrant: QDRANT_URL, collection: COLLECTION }));

app.listen(PORT, () => {
  console.log(`reg-mcp HTTP/SSE server on http://localhost:${PORT}`);
  console.log(`  Qdrant: ${QDRANT_URL} | collection: ${COLLECTION}`);
  console.log(`  Embed:  ${process.env.EMBED_MODEL}`);
});
