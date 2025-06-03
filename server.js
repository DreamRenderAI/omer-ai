require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Cerebras = require('@cerebras/cerebras_cloud_sdk');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Cerebras client
const cerebras = new Cerebras({
    apiKey: process.env.CEREBRAS_API_KEY
});

// Serve static files from the 'public' folder
app.use(express.static('public'));

// Set up WebSocket server
const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const userMessage = message.toString('utf8');
            console.log('Received user message:', userMessage);

            // Send user message back to client
            ws.send(JSON.stringify({ role: 'user', content: userMessage }));

            // Load system message from system.txt
            const systemPromptPath = path.join(__dirname, 'system.txt');
            const systemContent = fs.readFileSync(systemPromptPath, 'utf8');

            // Stream response from Cerebras
            const stream = await cerebras.chat.completions.create({
                messages: [
                    { role: 'system', content: systemContent },
                    { role: 'user', content: userMessage }
                ],
                model: 'llama-3.3-70b',
                stream: true,
                max_completion_tokens: 2048,
                temperature: 0.7,
                top_p: 1
            });

            // Buffer to accumulate full AI response
            let fullResponse = '';
            let promptDetected = false;

            // Send each chunk to the client and accumulate
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                console.log('Raw chunk:', content);
                if (content) {
                    // Remove _prompt: part from the content before sending to client
                    let visibleContent = content;
                    if (content.includes('_prompt:')) {
                        visibleContent = content.split('_prompt:')[0].trim();
                    }
                    
                    // Only send if there's visible content
                    if (visibleContent) {
                        ws.send(JSON.stringify({ role: 'ai', content: visibleContent }));
                    }
                    
                    // Append chunk to full response
                    fullResponse += content;
                    // Check for prompt in chunk
                    if (content.match(/_?prompt: ?[^_]+_?/)) {
                        promptDetected = true;
                    }
                }
            }

            // Send AI completion signal with prompt detection status
            ws.send(JSON.stringify({ role: 'ai_complete', promptDetected }));

            // Check full response for image prompt
            console.log('Full response:', fullResponse);
            const promptMatch = fullResponse.match(/_?prompt: ?[^_]+_?/);
            if (promptMatch) {
                console.log('Prompt detected:', promptMatch[0]);
                const imagePrompt = promptMatch[0].replace(/_?prompt: ?/, '').replace(/_$/, '').trim();
                const seed = Math.floor(Math.random() * 1000000000) + 1;
                const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&seed=${seed}`;
                console.log('Image URL:', imageUrl);
                ws.send(JSON.stringify({ role: 'image', content: imageUrl }));
            }
        } catch (error) {
            console.error('Error with Cerebras API or file:', error);
            ws.send(JSON.stringify({ role: 'ai', content: 'Sorry, I encountered an error, bro!' }));
        }
    });
});
