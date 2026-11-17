// RosCAM is served by the Parts Tracker (parts.frc5572.org/cnc/roscam/) and uses its Auth0
// login and its /api/roscam/ endpoints. These match the Parts Tracker board's settings.
window.ROSCAM_CONFIG = {
  apiBase: window.location.origin,
  auth0Domain: 'login.frc5572.org',
  auth0ClientId: '3DIkQirwReuUotmcBcozUMlRHBKd60TX',
  auth0Audience: 'https://parts.frc5572.org',
};
