const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000").replace(/\/$/, "");
const API_PREFIX = import.meta.env.VITE_API_PREFIX || "/api/v1";

const buildUrl = (path) => `${API_BASE_URL}${API_PREFIX}${path}`;

async function request(path, options = {}) {
  const response = await fetch(buildUrl(path), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let body = null;
  let textBody = "";
  try {
    textBody = await response.text();
    body = textBody ? JSON.parse(textBody) : null;
  } catch {
    body = textBody ? { message: textBody } : null;
  }

  if (!response.ok) {
    const message =
      body?.message || body?.error || response.statusText || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = body;
    throw error;
  }

  return body;
}

export async function signup(payload) {
  return request("/auth/signup", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function signin(payload) {
  return request("/auth/signin", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function logout() {
  return request("/auth/logout", {
    method: "POST",
  });
}

export async function getCurrentUser() {
  const response = await request("/auth/me", {
    method: "GET",
  });

  return response?.user || null;
}

export async function getDocs() {
  const response = await request("/docs", {
    method: "GET",
  });

  return response?.data || [];
}

export async function createDoc(payload) {
  const response = await request("/docs/createdocs", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return response?.data;
}

export async function updateDoc(docId, payload) {
  const response = await request(`/docs/updatedocs/${docId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  return response?.data;
}

export async function addCollaborator(docId, payload) {
  const response = await request(`/docs/addcollaborator/${docId}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return response?.data;
}

export async function deleteDoc(docId) {
  await request(`/docs/deletedocs/${docId}`, {
    method: "DELETE",
  });
}

export { API_BASE_URL };
