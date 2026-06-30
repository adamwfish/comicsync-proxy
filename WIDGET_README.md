# RoboPictoComics Homepage Widget

A thin, beautiful homepage widget that brings together:
- 📰 Latest blog post from Derailed
- ☀️ Live weather data (geolocation-aware)
- 📅 Today's date
- ⭐ Endless stream of Golden Age & Silver Age comic book fun facts

## Features

### Compact Design
- 380px wide × 600px tall self-contained widget
- Responsive, mobile-friendly layout
- Gradient purple theme with smooth animations

### Live Data
- **Blog**: Pulls latest post from derailed.co RSS feed
- **Weather**: Uses Open-Meteo API (free, no key required) with automatic geolocation
- **Fun Facts**: Over 60+ comic book facts with infinite pagination
  - 5 facts loaded per page
  - Endless scrolling through comic history
  - Covers both Golden Age (1938-1956) and Silver Age (1956-1970) comics

### Auto-Refresh
- Blog and weather refresh every 60 minutes
- Fun facts load on-demand as user scrolls

## Installation

### Option 1: Embed as Standalone Page
Access the widget directly at:
```
https://your-proxy-url/widget.html
```

### Option 2: Embed as iFrame on Homepage
```html
<iframe 
  src="https://your-proxy-url/widget.html" 
  width="380" 
  height="600" 
  frameborder="0" 
  style="border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.2);">
</iframe>
```

### Option 3: Self-Hosted Widget
Copy `widget.html` to your robopictocomics.com server and update the `WIDGET_API` variable in the script:
```javascript
const WIDGET_API = 'https://your-proxy-url/widget'; // or relative path
```

## API Endpoints

All endpoints are built into the proxy server:

### GET `/widget/blog-latest`
Returns the latest blog post from derailed.co
```json
{
  "success": true,
  "title": "Post Title",
  "url": "https://derailed.co/...",
  "date": "2026-06-30T12:00:00Z",
  "excerpt": "Post summary..."
}
```

### GET `/widget/weather?lat=40.7128&lon=-74.0060`
Returns current weather data (defaults to NYC if coords not provided)
```json
{
  "success": true,
  "temp": 72,
  "condition": "Partly Cloudy",
  "isDaytime": true
}
```

### GET `/widget/fun-facts?page=0`
Returns 5 comic book fun facts per page (infinite pagination)
```json
{
  "success": true,
  "facts": [
    "Action Comics #1 (1938)...",
    "Batman debuted in 1939..."
  ],
  "page": 0,
  "total": 60,
  "hasMore": true
}
```

## Customization

### Change Widget Size
Edit the `.widget` CSS class:
```css
.widget {
  max-width: 380px;    /* Change width */
  height: 600px;       /* Change height */
}
```

### Add More Fun Facts
Edit the `COMIC_FUN_FACTS` array in `server.js`:
```javascript
const COMIC_FUN_FACTS = [
  "Your fact here...",
  // ... more facts
];
```

### Change Theme Colors
The widget uses a purple gradient. Update these in `widget.html`:
- Primary: `#667eea` (blue-purple)
- Secondary: `#764ba2` (dark purple)

```css
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
```

## Browser Support
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires JavaScript enabled
- Geolocation optional (falls back to NYC coordinates)

## Notes
- Blog RSS feed fetched from derailed.co's `/feed.json`
- Weather uses Open-Meteo (no API key, no rate limits for reasonable use)
- All fun facts are embedded in server (no external DB needed)
- Widget is responsive and works great on mobile too

## Deployment
1. Push this repo to Render/Vercel/wherever you host
2. Update environment variable for `SQUARESPACE_API_KEY`
3. Embed the widget URL on robopictocomics.com
4. Done! Updates happen automatically
