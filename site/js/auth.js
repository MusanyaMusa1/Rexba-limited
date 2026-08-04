// =====================================================================
// RMMIS Pilot — Login logic
// Everyone (admin, manager, vendor) logs in with phone + password.
// Under the hood Supabase Auth needs an email, so we derive one from
// the phone number: 0701234567 -> 0701234567@vendor.rexba.local
// =====================================================================

function phoneToSyntheticEmail(phone) {
  const digits = phone.replace(/\D/g, "");
  return `${digits}@vendor.rexba.local`;
}

function showError(msg) {
  const box = document.getElementById("errorBox");
  box.textContent = msg;
  box.classList.remove("hidden");
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value;
  const btn = document.getElementById("loginBtn");
  const errorBox = document.getElementById("errorBox");

  errorBox.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Signing in...";

  const email = phoneToSyntheticEmail(phone);

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    showError("Incorrect phone number or password.");
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  // Confirm the account has an app_users profile (role) before moving on.
  const { data: profile, error: profileErr } = await supabase
    .from("app_users")
    .select("role, is_active")
    .eq("id", data.user.id)
    .single();

  if (profileErr || !profile) {
    showError("Your account isn't fully set up yet. Contact your administrator.");
    await supabase.auth.signOut();
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  if (!profile.is_active) {
    showError("This account has been deactivated. Contact your administrator.");
    await supabase.auth.signOut();
    btn.disabled = false;
    btn.textContent = "Sign in";
    return;
  }

  window.location.href = "dashboard.html";
});
