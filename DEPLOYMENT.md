# Deployment Checklist

## Before Deploying

### Backend (Node.js Server)

- [x] `npm start` script added to package.json
- [x] `npm run dev` script for development
- [x] CORS_ORIGIN has fallback to prevent crashes
- [x] `.env.example` created for reference
- [ ] **IMPORTANT**: Remove real credentials from `.env` before committing
- [ ] Test locally: `npm run dev` starts without errors
- [ ] All environment variables documented in `.env.example`

**Environment Variables Required:**
```
PORT=3000
NODE_ENV=production
MONGO_URI=mongodb+srv://...
JWT_SECRET=strong-random-string
CORS_ORIGIN=https://your-frontend-domain.com
OPERATION_DEBOUNCE_MS=120
```

### Frontend (React + Vite)

- [x] Build script configured (`vite build`)
- [x] `.env.example` created
- [ ] Test production build locally: `npm run build && npm run preview`
- [ ] `VITE_API_BASE_URL` points to backend deployment URL
- [ ] `.env.production` configured if separate from `.env`

**Environment Variables Required:**
```
VITE_API_BASE_URL=https://your-backend-domain.com
VITE_API_PREFIX=/api/v1
VITE_APP_NAME=Collab Docs
```

## Deployment Platforms

### Option 1: Backend on Railway + Frontend on Vercel (Recommended)

#### Railway Setup (Backend)
1. Push code to GitHub
2. Create Railway project, connect GitHub repo
3. Set environment variables in Railway dashboard:
   - `MONGO_URI`
   - `JWT_SECRET`
   - `CORS_ORIGIN=https://your-vercel-app.vercel.app`
   - `NODE_ENV=production`
4. Railway auto-runs `npm start`
5. Get backend URL from Railway dashboard

#### Vercel Setup (Frontend)
1. Push code to GitHub
2. Import `frontend` folder in Vercel
3. Set environment variables in Vercel:
   - `VITE_API_BASE_URL=https://your-railway-app.railway.app`
   - `VITE_API_PREFIX=/api/v1`
4. Deploy → Vercel generates frontend URL
5. Update backend `CORS_ORIGIN` to include frontend URL

### Option 2: Both on Same Platform (Railway)

If deploying both on same platform (monorepo approach):
1. Move frontend to `apps/frontend` or keep separate deploy
2. Update Railway to build both:
   - Backend: root `npm start`
   - Frontend: built to static `/public` folder, served via Express
3. Would require Express static middleware setup

## Post-Deployment Checklist

- [ ] Test login/signup flow
- [ ] Create a document and verify real-time editing works
- [ ] Open document in 2 browsers, test live cursors
- [ ] Check browser console for errors
- [ ] Verify database writes are persisting
- [ ] Test adding collaborators
- [ ] Monitor logs for any warnings

## Common Issues & Fixes

### "Unauthorized: token missing/invalid"
- Check CORS_ORIGIN matches frontend domain exactly
- Verify cookies are being sent with credentials

### "Cannot connect to database"
- Verify MONGO_URI is correct
- Check IP whitelist in MongoDB Atlas (allow 0.0.0.0/0 for testing)
- Ensure `mongodb+srv://` protocol is used

### "CORS error in browser console"
- CORS_ORIGIN must include HTTPS protocol
- Add trailing slash if needed: `https://domain.com/`
- Must be exact match or wildcard won't work

### Socket.IO connection fails
- Check `CORS_ORIGIN` matches frontend domain
- Verify transports: `['websocket', 'polling']` allows fallback
- Check browser DevTools → Network → WS tab

## Security Reminders

⚠️ **Before production:**
1. **Rotate JWT_SECRET** — Use `openssl rand -base64 32`
2. **Create new MongoDB user** — Don't use shared credentials
3. **Enable HTTPS** — All deployment platforms provide free SSL
4. **Restrict CORS_ORIGIN** — Only allow your frontend domain
5. **Remove console.logs** — Or use proper logging library
6. **Test rate limiting** — Verify auth endpoints are protected

## Monitoring

Set up alerts for:
- Database connection errors
- Failed authentication attempts
- Memory/CPU usage spikes
- Socket.IO connection drops

Use platform-native monitoring:
- **Railway**: Built-in logs & metrics
- **Vercel**: Analytics & logs
- **MongoDB Atlas**: Performance metrics

## Rollback Plan

If deployment fails:
1. Check Railway/Vercel deployment logs
2. Verify environment variables are set correctly
3. Roll back to previous commit
4. Test fix locally before re-deploying
