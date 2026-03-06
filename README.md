# ComicSync Proxy

Tiny Express server that proxies Squarespace API calls from ComicSync.

## Deploy to Render (free)

1. Push this repo to GitHub
2. Go to render.com → New → Web Service
3. Connect this repo
4. Set these:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add environment variable:
   - `SQUARESPACE_API_KEY` = your Squarespace API key
6. Deploy — copy the URL Render gives you (e.g. https://comicsync-proxy.onrender.com)
7. Paste that URL into ComicSync.html where it says `PROXY_URL`
