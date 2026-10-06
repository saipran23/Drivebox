export function openGoogleDriveConnection() {
  // Open a same-origin page synchronously so popup blockers permit it. That
  // page obtains the OAuth URL with the app token, including refresh/re-login.
  const popup = window.open('/connect-google', 'google-drive-connect', 'width=540,height=720')
  if (!popup) window.location.assign('/connect-google')
}
