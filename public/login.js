const formElement = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const submitButton = document.getElementById('submit-button');
const statusText = document.getElementById('status-text');

function setStatus(text, isError = false) {
  statusText.textContent = text || '';
  statusText.classList.toggle('error', isError);
}

async function requestAuthStatus() {
  const response = await fetch('/api/auth/status');
  if (!response.ok) {
    throw new Error(`Status check failed (${response.status})`);
  }
  return response.json();
}

async function initializeLoginPage() {
  try {
    const status = await requestAuthStatus();

    if (status.enabled !== true) {
      window.location.replace('/');
      return;
    }

    if (status.authenticated === true) {
      window.location.replace('/');
      return;
    }

    passwordInput.focus();
  } catch (_error) {
    setStatus('Unable to check authentication state right now.', true);
  }
}

formElement.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = passwordInput.value || '';

  if (!password) {
    setStatus('Password is required.', true);
    return;
  }

  submitButton.disabled = true;
  setStatus('Checking password...');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ password })
    });

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (_error) {
        payload = null;
      }
    }

    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `Login failed (${response.status})`;
      setStatus(message, true);
      passwordInput.select();
      return;
    }

    window.location.replace('/');
  } catch (_error) {
    setStatus('Network error while signing in.', true);
  } finally {
    submitButton.disabled = false;
  }
});

initializeLoginPage();
