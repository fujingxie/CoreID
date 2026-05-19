const { createHttpError, isProduction } = require("../utils/http");
const { getPublicEndpoint } = require("./casdoor");

let privilegeConsentReady = false;
let masterPasswordReady = false;

function getCasdoorEndpoint() {
  const endpoint = getPublicEndpoint();
  if (!endpoint) {
    throw createHttpError(503, "Casdoor endpoint is not configured");
  }
  return endpoint;
}

function getUserOwner() {
  return process.env.CASDOOR_USER_OWNER || "built-in";
}

function getSignupApplication() {
  return process.env.CASDOOR_SIGNUP_APPLICATION || "coreid-admin";
}

function getAdminUsername() {
  return process.env.CASDOOR_DEV_ADMIN_USERNAME || "built-in/admin";
}

function getAdminPassword() {
  return process.env.CASDOOR_DEV_ADMIN_PASSWORD || "123";
}

function getMasterPassword() {
  const configured = (process.env.CASDOOR_MASTER_PASSWORD || "").trim();
  if (configured) {
    return configured;
  }

  if (!isProduction()) {
    return "COREID-MASTER-DEV-001";
  }

  return "";
}

function buildPhoneUsername(phone) {
  return `u${phone}`;
}

function buildSyntheticEmail(phone) {
  return `${buildPhoneUsername(phone)}@dev.coreid.local`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return { response, payload };
}

function requireOk(payload, fallbackMessage) {
  if (payload?.status !== "ok") {
    throw createHttpError(400, payload?.msg || fallbackMessage);
  }
}

async function getAdminAccount() {
  const endpoint = getCasdoorEndpoint();
  const url = new URL(`${endpoint}/api/get-account`);
  url.searchParams.set("username", getAdminUsername());
  url.searchParams.set("password", getAdminPassword());

  const { payload } = await fetchJson(url.toString());
  requireOk(payload, "Failed to sign in to Casdoor admin account");
  return payload;
}

async function getAdminAccessToken() {
  const adminPayload = await getAdminAccount();
  const token = adminPayload?.data?.accessToken;

  if (!token) {
    throw createHttpError(500, "Casdoor admin access token is missing");
  }

  return token;
}

async function ensurePrivilegeConsentEnabled() {
  if (privilegeConsentReady || getUserOwner() !== "built-in") {
    return;
  }

  const endpoint = getCasdoorEndpoint();
  const adminPayload = await getAdminAccount();
  const token = adminPayload?.data?.accessToken;
  const organization = adminPayload?.data2;

  if (!organization) {
    throw createHttpError(500, "Casdoor organization profile is unavailable");
  }

  if (organization.hasPrivilegeConsent) {
    privilegeConsentReady = true;
    return;
  }

  const updatedOrganization = {
    ...organization,
    hasPrivilegeConsent: true,
  };

  const { payload } = await fetchJson(`${endpoint}/api/update-organization?id=admin/built-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updatedOrganization),
  });

  requireOk(payload, "Failed to enable Casdoor privilege consent");
  privilegeConsentReady = true;
}

async function ensureMasterPasswordConfigured() {
  const masterPassword = getMasterPassword();
  if (!masterPassword || getUserOwner() !== "built-in") {
    return;
  }

  const endpoint = getCasdoorEndpoint();
  const adminPayload = await getAdminAccount();
  const token = adminPayload?.data?.accessToken;
  const organization = adminPayload?.data2;

  if (!organization) {
    throw createHttpError(500, "Casdoor organization profile is unavailable");
  }

  if (masterPasswordReady && organization.masterPassword === masterPassword) {
    return;
  }

  if (organization.masterPassword === masterPassword) {
    masterPasswordReady = true;
    return;
  }

  const updatedOrganization = {
    ...organization,
    masterPassword,
  };

  const { payload } = await fetchJson(`${endpoint}/api/update-organization?id=admin/built-in`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updatedOrganization),
  });

  requireOk(payload, "Failed to configure Casdoor master password");
  masterPasswordReady = true;
}

function normalizeCasdoorAccount(account) {
  return {
    sub: account.id,
    username: account.name,
    email: account.email || null,
    phone: account.phone || null,
    picture: account.avatar || null,
    roles: Array.isArray(account.roles) ? account.roles : [],
    isAdmin: Boolean(account.isAdmin),
    isGlobalAdmin: false,
  };
}

async function getCasdoorUserByName(username) {
  const endpoint = getCasdoorEndpoint();
  const token = await getAdminAccessToken();
  const { payload } = await fetchJson(
    `${endpoint}/api/get-user?id=${encodeURIComponent(`${getUserOwner()}/${username}`)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  requireOk(payload, "Failed to load Casdoor user");
  return payload.data;
}

async function updateCasdoorUser({ currentUsername, username, email, password }) {
  await ensurePrivilegeConsentEnabled();

  const endpoint = getCasdoorEndpoint();
  const token = await getAdminAccessToken();
  const currentUser = await getCasdoorUserByName(currentUsername);
  const nextUsername = username || currentUser.name;
  const payloadBody = {
    ...currentUser,
    name: nextUsername,
    displayName: nextUsername,
    email: email ?? currentUser.email ?? "",
  };

  if (password) {
    payloadBody.password = password;
    payloadBody.passwordType = "plain";
    payloadBody.passwordSalt = "";
    payloadBody.needUpdatePassword = false;
  }

  const { payload } = await fetchJson(
    `${endpoint}/api/update-user?id=${encodeURIComponent(`${getUserOwner()}/${currentUsername}`)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payloadBody),
    }
  );

  requireOk(payload, "Failed to update Casdoor user");
  return getCasdoorUserByName(nextUsername);
}

async function createCasdoorUser({ phone, password, displayName, countryCode = "CN" }) {
  await ensurePrivilegeConsentEnabled();

  const endpoint = getCasdoorEndpoint();
  const token = await getAdminAccessToken();
  const username = buildPhoneUsername(phone);
  const body = {
    owner: getUserOwner(),
    name: username,
    displayName: displayName || phone,
    email: buildSyntheticEmail(phone),
    phone,
    countryCode,
    password,
    signupApplication: getSignupApplication(),
  };

  const { payload } = await fetchJson(`${endpoint}/api/add-user`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (payload?.status !== "ok") {
    if (/already exists/i.test(payload?.msg || "")) {
      return getCasdoorUserByName(username);
    }
    throw createHttpError(400, payload?.msg || "Failed to create Casdoor user");
  }

  return getCasdoorUserByName(username);
}

async function signInWithPassword({ username, password }) {
  const endpoint = getCasdoorEndpoint();
  const url = new URL(`${endpoint}/api/get-account`);
  url.searchParams.set("username", `${getUserOwner()}/${username}`);
  url.searchParams.set("password", password);

  const { payload } = await fetchJson(url.toString());

  if (payload?.status !== "ok" || !payload?.data) {
    throw createHttpError(401, payload?.msg || "Phone number or password is incorrect");
  }

  return {
    profile: normalizeCasdoorAccount(payload.data),
    accessToken: payload.data.accessToken || null,
    rawUser: payload.data,
  };
}

async function setCasdoorPassword({ username, oldPassword, newPassword, resetMode = false }) {
  if (resetMode) {
    const masterPassword = getMasterPassword();
    if (!masterPassword) {
      throw createHttpError(503, "Casdoor master password is not configured");
    }

    await ensureMasterPasswordConfigured();

    const endpoint = getCasdoorEndpoint();
    const login = await signInWithPassword({ username, password: masterPassword });
    const form = new URLSearchParams({
      userOwner: getUserOwner(),
      userName: username,
      oldPassword: masterPassword,
      newPassword,
    });

    const response = await fetch(`${endpoint}/api/set-password`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${login.accessToken}`,
      },
      body: form.toString(),
    });

    const payload = await response.json();
    requireOk(payload, "Failed to reset Casdoor password");
    return payload;
  }

  const endpoint = getCasdoorEndpoint();
  const login = await signInWithPassword({ username, password: oldPassword });
  const form = new URLSearchParams({
    userOwner: getUserOwner(),
    userName: username,
    oldPassword,
    newPassword,
  });

  const response = await fetch(`${endpoint}/api/set-password`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${login.accessToken}`,
    },
    body: form.toString(),
  });

  const payload = await response.json();
  requireOk(payload, "Failed to update Casdoor password");
  return payload;
}

module.exports = {
  buildPhoneUsername,
  buildSyntheticEmail,
  createCasdoorUser,
  getSignupApplication,
  setCasdoorPassword,
  updateCasdoorUser,
  signInWithPassword,
};
