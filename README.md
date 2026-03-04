# 🕰️ Old Timey AI

A fun, vintage-themed website where users can chat with an AI that only "knows" history up to a date they choose!

![Old Timey AI](https://images.unsplash.com/photo-1461360370896-922624d12a74?w=800)

## Features

- 📜 Beautiful vintage parchment design with sepia tones
- 🗓️ User selects any historical date as the AI's "knowledge cutoff"
- 💬 Chat interface with the AI roleplaying as if it's living in that time period
- ⚡ Quick-select buttons for famous historical dates
- 📱 Fully responsive design

## Setup Instructions

### 1. Prerequisites

- Node.js 18+ installed
- A Claude API key from [Anthropic Console](https://console.anthropic.com)

### 2. Installation

```bash
# Clone or download the files to your server
cd old-timey-ai

# Install dependencies
npm install

# Create your environment file
cp .env.example .env

# Edit .env and add your API key
nano .env
```

### 3. Configure Your API Key

Edit the `.env` file and replace the placeholder with your actual Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-api03-YOUR-ACTUAL-KEY-HERE
```

### 4. File Structure

```
old-timey-ai/
├── public/
│   └── index.html      # Frontend (move index.html here)
├── server.js           # Backend Express server
├── package.json        # Node.js dependencies
├── .env               # Your API key (DO NOT COMMIT)
├── .env.example       # Example env file
└── README.md          # This file
```

**Important:** Move `index.html` into a `public/` folder!

```bash
mkdir public
mv index.html public/
```

### 5. Run Locally

```bash
# Development mode (auto-restart on changes)
npm run dev

# Production mode
npm start
```

Visit `http://localhost:3000` to see your site!

## Deployment Options

### Option A: Deploy to Render.com (Free Tier Available)

1. Push your code to GitHub
2. Go to [render.com](https://render.com) and create a new Web Service
3. Connect your GitHub repo
4. Set environment variables:
   - `ANTHROPIC_API_KEY` = your API key
5. Deploy!

### Option B: Deploy to Railway.app

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) and create a new project
3. Add your GitHub repo
4. Add environment variable: `ANTHROPIC_API_KEY`
5. Deploy!

### Option C: Deploy to a VPS (DigitalOcean, Linode, etc.)

1. SSH into your server
2. Install Node.js 18+
3. Clone your repo
4. Run with PM2 for production:

```bash
npm install -g pm2
npm install
pm2 start server.js --name "old-timey-ai"
pm2 save
```

5. Set up Nginx as reverse proxy (recommended)

### Option D: Deploy to Vercel (Serverless)

For Vercel, you'll need to convert to serverless functions. Create `api/chat.js`:

```javascript
// api/chat.js
export default async function handler(req, res) {
    // ... similar logic to server.js endpoint
}
```

## Pointing Your Domain

1. In your domain registrar (where you bought oldtimeyai.com):
   - Point A record to your server's IP, OR
   - Point to your hosting service's DNS

2. Configure SSL (HTTPS):
   - Use Let's Encrypt for free SSL
   - Most cloud platforms handle this automatically

## Security Notes

⚠️ **NEVER** commit your `.env` file or expose your API key!

- Add `.env` to your `.gitignore`
- Use environment variables in your hosting platform
- The API key stays on the server and is never sent to browsers

## Customization

### Change Historical Images

Edit the image URLs in `index.html`. The current images are from Unsplash (free to use). Replace with any images you prefer:

```html
<div class="history-image">
    <img src="YOUR_IMAGE_URL_HERE" alt="Description">
    <div class="image-caption">Your Caption</div>
</div>
```

### Add More Era Quick-Select Buttons

In `index.html`, add more buttons to the `.era-suggestions` div:

```html
<button class="era-btn" onclick="setEra(4, 15, 1912)">🚢 Titanic Sinks</button>
```

### Change AI Personality

Edit the `systemPrompt` in `server.js` to adjust how the AI speaks and behaves.

## Troubleshooting

**"ANTHROPIC_API_KEY not found"**
- Make sure you created a `.env` file (not just `.env.example`)
- Make sure the key is correct with no extra spaces

**"Failed to get response from AI"**
- Check your API key is valid
- Check you have credits in your Anthropic account
- Check the server console for detailed errors

**Images not loading**
- Unsplash URLs should work automatically
- If using custom images, ensure they're publicly accessible

## License

MIT License - feel free to use and modify!

---

Built with ❤️ using Claude by Anthropic
