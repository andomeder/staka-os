// M0 engine evaluation gate driver. Run against a local supermemory-server
// on :6767 with the fixtures in test/fixtures/kb/.
const BASE = "http://localhost:6767";
const ORG_A = "org_staka_eval_a";
const ORG_B = "org_staka_eval_b";

async function api(path, body, method = "POST") {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	try {
		return { status: res.status, body: JSON.parse(text) };
	} catch {
		return { status: res.status, body: text.slice(0, 500) };
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ingest(content, customId, containerTag, metadata) {
	const r = await api("/v3/documents", {
		content,
		customId,
		containerTag,
		metadata,
	});
	if (r.status !== 200) throw new Error(`ingest ${customId}: ${r.status} ${JSON.stringify(r.body)}`);
	return r.body;
}

async function waitDone(id, label) {
	for (let i = 0; i < 120; i++) {
		const r = await api(`/v3/documents/${id}`, undefined, "GET");
		const status = r.body?.status ?? r.body?.processing?.status ?? "unknown";
		if (status === "done" || status === "completed") return status;
		if (status === "failed") throw new Error(`${label} failed: ${JSON.stringify(r.body).slice(0, 400)}`);
		await sleep(2000);
	}
	throw new Error(`${label}: timeout waiting for done`);
}

async function search(q, containerTag, searchMode = "documents", limit = 5) {
	const r = await api("/v4/search", { q, containerTag, searchMode, limit });
	if (r.status !== 200) throw new Error(`search: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
	return r.body;
}

function resultsOf(body) {
	return (body.results ?? []).map((x) => ({
		id: x.documentId ?? x.customId ?? x.id,
		memory: x.memory,
		chunk: x.chunk,
		similarity: x.similarity,
		metadata: x.metadata,
	}));
}

const fixtureDir = new URL("./test/fixtures/kb/", `file://${process.cwd()}/`).pathname;
const docs = {
	"q3-reporting-procedure": await Bun.file(`${fixtureDir}docs/q3-reporting-procedure.md`).text(),
	"expense-claim-policy": await Bun.file(`${fixtureDir}docs/expense-claim-policy.md`).text(),
	"vpn-setup": await Bun.file(`${fixtureDir}docs/vpn-setup.md`).text(),
	"leave-procedure": await Bun.file(`${fixtureDir}docs/leave-procedure.md`).text(),
	"orgb-facilities": await Bun.file(`${fixtureDir}docs/orgb-facilities.md`).text(),
};
const profiles = {
	"EMP-0104": await Bun.file(`${fixtureDir}profiles/john-mwangi.md`).text(),
	"EMP-0233": await Bun.file(`${fixtureDir}profiles/grace-wanjiru.md`).text(),
};

console.log("== ingest org_a docs ==");
for (const [id, content] of Object.entries(docs)) {
	if (id === "orgb-facilities") continue;
	const r = await ingest(content, `doc:${id}`, ORG_A, {
		org_id: "a", source: "upload", uploaded_by: "admin", doc_type: "procedure",
	});
	console.log(id, r.status ?? r.id);
}
console.log("== ingest org_a profiles ==");
for (const [id, content] of Object.entries(profiles)) {
	const r = await ingest(content, `profile:${id}`, ORG_A, {
		org_id: "a", source: "directory", doc_type: "profile",
	});
	console.log(id, r.status ?? r.id);
}
console.log("== ingest org_b doc ==");
const rb = await ingest(docs["orgb-facilities"], "doc:orgb-facilities", ORG_B, {
	org_id: "b", source: "upload", uploaded_by: "admin", doc_type: "policy",
});
console.log("orgb-facilities", rb.status ?? rb.id);

// poll until all done
console.log("== waiting for processing ==");
const allIds = [
	...Object.keys(docs).filter((k) => k !== "orgb-facilities").map((k) => `doc:${k}`),
	...Object.keys(profiles).map((k) => `profile:${k}`),
	"doc:orgb-facilities",
];
for (const id of allIds) {
	const r = await api("/v3/documents/list", { containerTags: [id.startsWith("profile") ? ORG_A : (id === "doc:orgb-facilities" ? ORG_B : ORG_A)], limit: 50 });
	// list may differ; fall back to direct status
}
const t0 = Date.now();
let pending = [...allIds];
while (pending.length > 0 && Date.now() - t0 < 240_000) {
	await sleep(4000);
	const still = [];
	for (const id of pending) {
		try {
			const r = await api(`/v3/documents/${encodeURIComponent(id)}`, undefined, "GET");
			const s = r.body?.status ?? r.body?.processing?.status;
			process.stdout.write(`${id}=${s ?? JSON.stringify(r.body).slice(0, 80)}\n`);
			if (s !== "done" && s !== "completed") still.push(id);
		} catch {
			still.push(id);
		}
	}
	pending = still;
}
console.log("remaining pending:", pending);

console.log("\n== queries ==");
const queries = await Bun.file(`${fixtureDir}queries.json`).json();
let pass = 0, fail = 0;
for (const q of queries) {
	const tag = q.org === "org_b" ? ORG_B : ORG_A;
	for (const mode of ["documents", "hybrid"]) {
		try {
			const body = await search(q.query, tag, mode);
			const rs = resultsOf(body);
			const ids = rs.map((x) => x.id);
			const wantDoc = q.expect_doc_id ? ids.some((i) => String(i).includes(q.expect_doc_id)) : true;
			const wantProfile = q.expect_profile
				? rs.some((x) => JSON.stringify(x).includes(q.expect_profile))
				: true;
			const ok = wantDoc && wantProfile;
			if (ok) pass++; else fail++;
			console.log(
				`[${mode}] ${ok ? "PASS" : "FAIL"} "${q.query}"` +
					`\n  top: ${rs.slice(0, 3).map((x) => `${x.id}(${x.similarity?.toFixed?.(2)})`).join(", ")}`,
			);
		} catch (e) {
			fail++;
			console.log(`[${mode}] ERROR "${q.query}": ${e.message}`);
		}
	}
}

console.log("\n== cross-org isolation ==");
for (const q of ["Q3 spreadsheet reporting procedure", "VPN setup", "meal allowance"]) {
	const body = await search(q, ORG_B, "hybrid");
	const rs = resultsOf(body);
	const leaked = rs.some((x) => JSON.stringify(x).toLowerCase().includes("q3") && !JSON.stringify(x).toLowerCase().includes("facilities"));
	console.log(`org_b query "${q}" -> ${rs.length} results${leaked ? " LEAK?" : ""}: ${rs.map((x) => x.id).join(", ") || "(none)"}`);
}
console.log(`\nRESULT pass=${pass} fail=${fail}`);
