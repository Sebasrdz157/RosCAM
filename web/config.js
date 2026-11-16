// Where the sheet inventory lives (Supabase). The publishable key is meant to be public:
// what it can do is limited by the database rules in supabase/schema.sql.
window.ROSCAM_CONFIG = {
  supabaseUrl: 'https://ugapgbvcnizrirzynhbw.supabase.co',
  supabaseKey: 'sb_publishable_k0-Dlg_Gs9BilEcrumI77A_NAev4E-l',
  // false: anyone can add and change sheets, no sign-in (matches supabase/schema.sql).
  // true: show a sign-in box; run supabase/lock_down.sql so the database enforces it too.
  requireSignIn: false,
  // Prefilled on the sign-in form when requireSignIn is true. Must be in public.editors.
  teamEmail: 'roscam@frc5572.org',
};
