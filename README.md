# Real-Time Collaborative Distributed System

A React + Node.js + Socket.IO application for real-time collaborative document editing with live cursor presence.

## Features

- 🚀 Real-time document editing via WebSockets
- 👁️ Live cursor tracking for all collaborators
- 🔐 JWT-based authentication
- 👥 Document ownership and collaboration management
- 📊 Version tracking for documents
- 🎯 Rate limiting and security middleware

## Tech Stack

**Backend:**
- Node.js + Express
- MongoDB with Mongoose
- Socket.IO for real-time sync
- JWT authentication

**Frontend:**
- React 19
- Vite
- Socket.IO Client

## Quick Start

### Prerequisites
- Node.js 16+
- MongoDB Atlas account (or local MongoDB)

### Setup

1. **Clone and install dependencies**
```bash
cd backend && npm install
cd ../frontend && npm install
```

2. **Configure environment variables**

**Backend** (`backend/.env`):
```bash
PORT=3000
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/dbname
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:5173
```

**Frontend** (`frontend/.env`):
```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_API_PREFIX=/api/v1
VITE_APP_NAME=Collab Docs
```

3. **Start development servers**

Backend:
```bash
cd backend
npm run dev
```

Frontend:
```bash
cd frontend
npm run dev
```

Server runs on `http://localhost:3000`, frontend on `http://localhost:5173`.

## Scripts

### Backend
- `npm start` — Production server
- `npm run dev` — Development with auto-reload (nodemon)

### Frontend
- `npm run dev` — Development server
- `npm run build` — Production build
- `npm run preview` — Preview built app
- `npm run lint` — ESLint check

## Deployment

### Backend (Railway/Heroku)
1. Set these environment variables on your platform:
   - `MONGO_URI` — MongoDB connection string
   - `JWT_SECRET` — Strong random string
   - `CORS_ORIGIN` — Your frontend domain
   - `NODE_ENV=production`

2. Platform will automatically run `npm start`

### Frontend (Vercel/Netlify)
1. Set `VITE_API_BASE_URL` to your backend URL
2. Trigger build from `frontend/` directory

## API Endpoints

**Authentication:**
- `POST /api/v1/auth/signup` — Create account
- `POST /api/v1/auth/signin` — Login
- `POST /api/v1/auth/logout` — Logout
- `GET /api/v1/auth/me` — Current user

**Documents:**
- `GET /api/v1/docs` — List user's docs
- `POST /api/v1/docs/createdocs` — Create document
- `PUT /api/v1/docs/updatedocs/:docId` — Update document
- `DELETE /api/v1/docs/deletedocs/:docId` — Delete document
- `POST /api/v1/docs/addcollaborator/:docId` — Add collaborator

## Socket Events

**Client → Server:**
- `join-document` — Enter collaborative space
- `leave-document` — Exit collaborative space
- `cursor-update` — Broadcast cursor position
- `document-content-change` — Update document content

**Server → Client:**
- `load-document` — Initial sync of document
- `presence-sync` — List of active collaborators
- `document-content-updated` — Sync changes from others
- `cursor-update` — Remote cursor position
- `cursor-removed` — Collaborator disconnected

## Architecture Notes

The backend maintains **room-based real-time sync** via Socket.IO:
1. JWT verification on socket connection
2. Documents grouped into named rooms
3. Content changes broadcast to all room members
4. Version counter tracks mutations
5. Cursor positions sent at 45ms debounce interval

## Security

- ✅ JWT tokens for authentication
- ✅ Permission checks (owner/collaborator validation)
- ✅ CORS whitelist (configurable)
- ✅ Rate limiting on auth routes
- ✅ Cookie-based token storage (httpOnly when HTTPS)

## License

ISC
