export async function GET() {
  const res = await fetch("https://api.hyperliquid-testnet.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "outcomeMeta" }),
  });
  const data = await res.json();
  return Response.json(data);
}
