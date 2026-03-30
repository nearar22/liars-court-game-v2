const prompt = "Is it factually true or false that Tunisia has no sea? Answer EXACTLY 'TRUE' or 'FALSE'.";
fetch('https://text.pollinations.ai/prompt/' + encodeURIComponent(prompt))
    .then(r => r.text())
    .then(console.log);
