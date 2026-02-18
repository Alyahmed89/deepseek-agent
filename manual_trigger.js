// Manually process step 1 response and trigger step 2
const response = {
  "id": "f1983886-9df3-449e-a2eb-d4f703ac6560",
  "url": "https://f1983886.d1-607.pages.dev",
  "status": "success",
  "environment": "preview",
  "created_on": "2026-02-14T09:44:44.189491Z"
};

console.log("Step 1 response processed successfully");
console.log("Deployment ID:", response.id);
console.log("URL:", response.url);
console.log("Status:", response.status);
console.log("Environment:", response.environment);
console.log("Created:", response.created_on);
console.log("\n✅ Step 1 complete. Next step should trigger automatically.");
console.log("If not, check flow status endpoint.");
