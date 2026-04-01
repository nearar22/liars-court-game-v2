
async function test() {
    console.log("Testing text.pollinations.ai POST api...");
    const res = await fetch('https://text.pollinations.ai/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: [
                {
                    role: 'system',
                    content: 'You are a strict encyclopedic fact-checker. You verify claims against real-world knowledge. You must respond with EXACTLY one word: TRUE or FALSE. Nothing else.'
                },
                {
                    role: 'user',
                    content: 'Theme: Knowledge\nClaim: "7+3=3"\n\nIs this claim factually correct? Respond with exactly TRUE or FALSE.'
                }
            ],
            jsonMode: false
        })
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
}
test();
