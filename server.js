require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const https = require('https');

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

// Map to store conversation history for each WebSocket connection
const conversationHistories = new Map();

// Function to convert image URL to base64
async function getBase64FromUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to fetch image: ${response.statusCode}`));
                return;
            }

            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = response.headers['content-type'];
                const base64Data = `data:${mimeType};base64,${base64}`;
                
                // Log the base64 data in the console
                console.log('Image converted to base64:');
                console.log(base64Data);
                
                resolve(base64Data);
            });
        }).on('error', reject);
    });
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('Client connected');

    // Initialize conversation history for this connection with the system prompt
    const systemPromptPath = path.join(__dirname, 'system.txt');
    const systemContent = fs.readFileSync(systemPromptPath, 'utf8');
    const initialHistory = [{ role: 'system', content: systemContent }];
    conversationHistories.set(ws, initialHistory);

    ws.on('message', async (message) => {
        try {
            const userMessage = message.toString('utf8');
            console.log('Received user message:', userMessage);

            // Get history for this connection and add the user message
            const history = conversationHistories.get(ws);
            if (!history) {
                console.error('History not found for connection');
                // Optionally send an error to the client or close the connection
                return;
            }
            history.push({ role: 'user', content: userMessage });

            // Stream response from Cerebras
            const stream = await cerebras.chat.completions.create({
                messages: history, // Send the full history
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

            // Add the full AI response to the history
            if (fullResponse.length > 0) {
                // Note: Cerebras API messages don't explicitly have 'ai' role, but this is our internal representation
                // Use 'assistant' role for API compatibility
                history.push({ role: 'assistant', content: fullResponse });
                conversationHistories.set(ws, history); // Update the map with the new history
            }

            // Check full response for image prompt
            console.log('Full response:', fullResponse);
            const promptMatch = fullResponse.match(/_?prompt: ?[^_]+_?/);
            if (promptMatch) {
                console.log('Prompt detected:', promptMatch[0]);
                const imagePrompt = promptMatch[0].replace(/_?prompt: ?/, '').replace(/_$/, '').trim();
                
                // Generate two images with different seeds and URLs
                const imageUrls = [
                    `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&seed=${Math.floor(Math.random() * 1000000000) + 1}&safe=true`,
                    `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&seed=${Math.floor(Math.random() * 1000000000) + 1}&safe=true&width=1024&height=1024&steps=50`
                ];
                
                const userAgents = [
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                ];

                for (let i = 0; i < 2; i++) {
                    console.log(`Fetching image ${i + 1} from URL:`, imageUrls[i]);
                    
                    try {
                        // Fetch and convert image to base64 with custom headers
                        const base64Image = await new Promise((resolve, reject) => {
                            https.get(imageUrls[i], {
                                headers: {
                                    'User-Agent': userAgents[i],
                                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                                    'Accept-Language': 'en-US,en;q=0.9',
                                    'Cache-Control': 'no-cache',
                                    'Pragma': 'no-cache'
                                }
                            }, (response) => {
                                if (response.statusCode !== 200) {
                                    reject(new Error(`Failed to fetch image: ${response.statusCode}`));
                                    return;
                                }

                                const chunks = [];
                                response.on('data', (chunk) => chunks.push(chunk));
                                response.on('end', () => {
                                    const buffer = Buffer.concat(chunks);
                                    const base64 = buffer.toString('base64');
                                    const mimeType = response.headers['content-type'];
                                    const base64Data = `data:${mimeType};base64,${base64}`;
                                    resolve(base64Data);
                                });
                            }).on('error', reject);
                        });

                        console.log(`Successfully converted image ${i + 1} to base64`);
                        
                        // Send base64 image to client
                        ws.send(JSON.stringify({ role: 'image', content: base64Image }));
                        console.log(`Base64 image ${i + 1} sent to client`);
                    } catch (error) {
                        console.error(`Error converting image ${i + 1} to base64:`, error);
                        ws.send(JSON.stringify({ role: 'ai', content: `Sorry, I encountered an error while generating image ${i + 1}!` }));
                    }
                }
            }
        } catch (error) {
            console.error('Error with Cerebras API or file:', error);
            ws.send(JSON.stringify({ role: 'ai', content: 'Sorry, I encountered an error, bro!' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        // Remove history for this connection when it closes
        conversationHistories.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        // Clean up history on error as well
        conversationHistories.delete(ws);
    });
});
