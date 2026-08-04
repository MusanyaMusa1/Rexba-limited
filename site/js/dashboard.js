// =====================================================================
// RMMIS Pilot — Dashboard logic
// Renders different tabs/data depending on the signed-in user's role.
// All data access relies on Supabase RLS — this file never assumes
// permissions, it just calls the API and lets Postgres enforce them.
// =====================================================================

let session, profile, vendorRow;

const TABS = {
  administrator: [
    { key: "applications", label: "Applications", render: renderAdminApplications },
    { key: "vendors", label: "Vendors", render: renderAdminVendors },
    { key: "markets", label: "Markets & Stalls", render: renderAdminMarkets },
  ],
  manager: [
    { key: "submit", label: "New Application", render: renderManagerSubmit },
    { key: "myvendors", label: "My Vendors", render: renderManagerVendors },
    { key: "payments", label: "Record Payment", render: renderManagerPayments },
  ],
  vendor: [
    { key: "profile", label: "My Profile", render: renderVendorProfile },
    { key: "idcard", label: "My Vendor ID", render: renderVendorId },
    { key: "history", label: "Payment History", render: renderVendorPayments },
  ],
};

async function init() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (!session) {
    window.location.href = "index.html";
    return;
  }

  const { data: p, error } = await supabase
    .from("app_users")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !p) {
    await supabase.auth.signOut();
    window.location.href = "index.html";
    return;
  }
  profile = p;

  document.getElementById("whoName").textContent = profile.full_name;
  const roleTag = document.getElementById("roleTag");
  roleTag.textContent = profile.role;
  roleTag.classList.add(profile.role === "administrator" ? "" : profile.role);

  if (profile.role === "vendor") {
    const { data: v } = await supabase.from("vendors").select("*").eq("id", session.user.id).single();
    vendorRow = v;
  }

  if (profile.force_password_reset) {
    document.getElementById("pwModal").classList.remove("hidden");
  }

  buildTabs();
}

function buildTabs() {
  const nav = document.getElementById("tabsNav");
  const tabs = TABS[profile.role] || [];
  nav.innerHTML = tabs.map((t, i) =>
    `<button data-key="${t.key}" class="${i === 0 ? "active" : ""}">${t.label}</button>`
  ).join("");

  nav.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      nav.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = tabs.find(t => t.key === btn.dataset.key);
      tab.render();
    });
  });

  if (tabs.length) tabs[0].render();
  else document.getElementById("content").innerHTML = `<div class="empty-state">No dashboard configured for this role yet.</div>`;
}

function toast(msg, isError = false) {
  const host = document.getElementById("toastHost");
  const el = document.createElement("div");
  el.className = `toast ${isError ? "error" : ""}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "index.html";
});

// ---------------------------------------------------------------------
// Forced password reset
// ---------------------------------------------------------------------
document.getElementById("savePwBtn").addEventListener("click", async () => {
  const pw = document.getElementById("newPw").value;
  const confirm = document.getElementById("confirmPw").value;
  const errBox = document.getElementById("pwError");
  errBox.classList.add("hidden");

  if (pw.length < 8) {
    errBox.textContent = "Password must be at least 8 characters.";
    errBox.classList.remove("hidden");
    return;
  }
  if (pw !== confirm) {
    errBox.textContent = "Passwords don't match.";
    errBox.classList.remove("hidden");
    return;
  }

  const { error: updateErr } = await supabase.auth.updateUser({ password: pw });
  if (updateErr) {
    errBox.textContent = updateErr.message;
    errBox.classList.remove("hidden");
    return;
  }

  await supabase.from("app_users").update({ force_password_reset: false }).eq("id", session.user.id);
  document.getElementById("pwModal").classList.add("hidden");
  toast("Password updated.");
});

// =====================================================================
// ADMINISTRATOR TABS
// =====================================================================
async function renderAdminApplications() {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card"><h3>Pending applications</h3><p class="card-sub">Review and approve or reject new vendor registrations.</p><div id="appsList">Loading...</div></div>`;

  const { data: apps, error } = await supabase
    .from("vendor_applications")
    .select("*, markets(name)")
    .order("created_at", { ascending: false });

  const list = document.getElementById("appsList");
  if (error) { list.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }
  if (!apps.length) { list.innerHTML = `<div class="empty-state">No applications yet.</div>`; return; }

  list.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Phone</th><th>Market</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${apps.map(a => `
          <tr>
            <td>${a.full_name}</td>
            <td>${a.phone}</td>
            <td>${a.markets?.name ?? "—"}</td>
            <td><span class="status-pill status-${a.status}">${a.status}</span></td>
            <td>
              ${a.status === "pending" ? `
                <button class="btn btn-accent btn-sm" data-approve="${a.id}">Approve</button>
                <button class="btn btn-ghost btn-sm" data-reject="${a.id}">Reject</button>
              ` : ""}
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;

  list.querySelectorAll("[data-approve]").forEach(btn => {
    btn.addEventListener("click", () => approveApplication(btn.dataset.approve, btn));
  });
  list.querySelectorAll("[data-reject]").forEach(btn => {
    btn.addEventListener("click", () => rejectApplication(btn.dataset.reject));
  });
}

async function approveApplication(applicationId, btn) {
  btn.disabled = true;
  btn.textContent = "Approving...";
  try {
    const res = await fetch(`${EDGE_FUNCTIONS_URL}/approve-application_index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ application_id: applicationId }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Approval failed");
    toast(`Approved — Vendor ID ${result.vendor_code} created.`);
    renderAdminApplications();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = "Approve";
  }
}

async function rejectApplication(applicationId) {
  const reason = prompt("Reason for rejection (optional):") || null;
  const { error } = await supabase
    .from("vendor_applications")
    .update({ status: "rejected", reviewed_by: session.user.id, reviewed_at: new Date().toISOString(), rejection_reason: reason })
    .eq("id", applicationId);
  if (error) { toast(error.message, true); return; }
  toast("Application rejected.");
  renderAdminApplications();
}

async function renderAdminVendors() {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card"><h3>All vendors</h3><p class="card-sub">Every vendor across every market.</p><div id="vendorsList">Loading...</div></div>`;

  const { data: vendors, error } = await supabase
    .from("vendors")
    .select("*, markets(name), app_users(full_name, phone)")
    .order("created_at", { ascending: false });

  const list = document.getElementById("vendorsList");
  if (error) { list.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }
  if (!vendors.length) { list.innerHTML = `<div class="empty-state">No vendors yet.</div>`; return; }

  list.innerHTML = `
    <table>
      <thead><tr><th>Vendor ID</th><th>Name</th><th>Phone</th><th>Market</th><th>Status</th></tr></thead>
      <tbody>
        ${vendors.map(v => `
          <tr>
            <td><code>${v.vendor_code}</code></td>
            <td>${v.app_users?.full_name ?? "—"}</td>
            <td>${v.app_users?.phone ?? "—"}</td>
            <td>${v.markets?.name ?? "—"}</td>
            <td><span class="status-pill status-${v.status}">${v.status}</span></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function renderAdminMarkets() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card">
      <h3>Markets</h3>
      <p class="card-sub">Markets currently configured in the system.</p>
      <div id="marketsList">Loading...</div>
    </div>`;

  const { data: markets, error } = await supabase.from("markets").select("*, sections(count)").order("name");
  const list = document.getElementById("marketsList");
  if (error) { list.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }
  if (!markets.length) { list.innerHTML = `<div class="empty-state">No markets configured yet. Add one directly in Supabase to get started.</div>`; return; }

  list.innerHTML = `
    <table>
      <thead><tr><th>Code</th><th>Name</th><th>Location</th><th>Sections</th></tr></thead>
      <tbody>
        ${markets.map(m => `
          <tr><td><code>${m.code}</code></td><td>${m.name}</td><td>${m.location ?? "—"}</td><td>${m.sections?.[0]?.count ?? 0}</td></tr>
        `).join("")}
      </tbody>
    </table>`;
}

// =====================================================================
// MANAGER TABS
// =====================================================================
async function renderManagerSubmit() {
  const content = document.getElementById("content");
  const marketId = profile.assigned_market_id;

  const { data: sections } = await supabase.from("sections").select("*, stalls(*)").eq("market_id", marketId);

  content.innerHTML = `
    <div class="card">
      <h3>Submit new vendor application</h3>
      <p class="card-sub">This goes to the administrator for approval — it does not create a live account yet.</p>
      <div id="submitError" class="error-msg hidden"></div>
      <div class="form-row">
        <div><label>Full name</label><input id="f_name" type="text" /></div>
        <div><label>Phone number</label><input id="f_phone" type="tel" placeholder="07XXXXXXXX" /></div>
      </div>
      <div class="form-row">
        <div><label>Email (optional)</label><input id="f_email" type="email" /></div>
        <div><label>National ID (optional)</label><input id="f_nid" type="text" /></div>
      </div>
      <div class="form-row">
        <div>
          <label>Section</label>
          <select id="f_section">
            <option value="">Select a section</option>
            ${(sections || []).map(s => `<option value="${s.id}">${s.name} (UGX ${s.monthly_fee}/mo)</option>`).join("")}
          </select>
        </div>
        <div>
          <label>Requested stall (optional)</label>
          <select id="f_stall"><option value="">Select a section first</option></select>
        </div>
      </div>
      <button class="btn btn-primary" id="submitAppBtn">Submit application</button>
    </div>`;

  const sectionSelect = document.getElementById("f_section");
  const stallSelect = document.getElementById("f_stall");
  sectionSelect.addEventListener("change", () => {
    const section = (sections || []).find(s => s.id === sectionSelect.value);
    const vacant = (section?.stalls || []).filter(st => st.status === "vacant");
    stallSelect.innerHTML = `<option value="">No specific stall</option>` +
      vacant.map(st => `<option value="${st.id}">${st.stall_number}</option>`).join("");
  });

  document.getElementById("submitAppBtn").addEventListener("click", async () => {
    const errBox = document.getElementById("submitError");
    errBox.classList.add("hidden");
    const full_name = document.getElementById("f_name").value.trim();
    const phone = document.getElementById("f_phone").value.trim();
    if (!full_name || !phone) {
      errBox.textContent = "Name and phone number are required.";
      errBox.classList.remove("hidden");
      return;
    }
    const { error } = await supabase.from("vendor_applications").insert({
      market_id: marketId,
      submitted_by: session.user.id,
      full_name,
      phone,
      email: document.getElementById("f_email").value.trim() || null,
      national_id: document.getElementById("f_nid").value.trim() || null,
      requested_section_id: sectionSelect.value || null,
      requested_stall_id: stallSelect.value || null,
    });
    if (error) {
      errBox.textContent = error.message;
      errBox.classList.remove("hidden");
      return;
    }
    toast("Application submitted for approval.");
    renderManagerSubmit();
  });
}

async function renderManagerVendors() {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card"><h3>Vendors in your market</h3><div id="mVendorsList">Loading...</div></div>`;

  const { data: vendors, error } = await supabase
    .from("vendors")
    .select("*, app_users(full_name, phone)")
    .eq("market_id", profile.assigned_market_id);

  const list = document.getElementById("mVendorsList");
  if (error) { list.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }
  if (!vendors.length) { list.innerHTML = `<div class="empty-state">No vendors in your market yet.</div>`; return; }

  list.innerHTML = `
    <table>
      <thead><tr><th>Vendor ID</th><th>Name</th><th>Phone</th><th>Status</th></tr></thead>
      <tbody>
        ${vendors.map(v => `
          <tr><td><code>${v.vendor_code}</code></td><td>${v.app_users?.full_name ?? "—"}</td><td>${v.app_users?.phone ?? "—"}</td>
          <td><span class="status-pill status-${v.status}">${v.status}</span></td></tr>`).join("")}
      </tbody>
    </table>`;
}

async function renderManagerPayments() {
  const content = document.getElementById("content");
  const { data: vendors } = await supabase
    .from("vendors")
    .select("id, vendor_code, app_users(full_name)")
    .eq("market_id", profile.assigned_market_id);

  content.innerHTML = `
    <div class="card">
      <h3>Record a payment</h3>
      <div id="paymentError" class="error-msg hidden"></div>
      <div class="form-row">
        <div>
          <label>Vendor</label>
          <select id="p_vendor">
            <option value="">Select a vendor</option>
            ${(vendors || []).map(v => `<option value="${v.id}">${v.vendor_code} — ${v.app_users?.full_name ?? ""}</option>`).join("")}
          </select>
        </div>
        <div><label>Amount (UGX)</label><input id="p_amount" type="number" min="0" /></div>
      </div>
      <div class="form-row">
        <div><label>For month</label><input id="p_month" type="date" /></div>
        <div>
          <label>Method</label>
          <select id="p_method">
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile money</option>
            <option value="bank">Bank</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <label>Stall</label>
      <select id="p_stall"><option value="">Select a vendor first</option></select>
      <button class="btn btn-primary" id="recordPaymentBtn" style="margin-top:8px;">Record payment</button>
    </div>`;

  const vendorSelect = document.getElementById("p_vendor");
  const stallSelect = document.getElementById("p_stall");
  vendorSelect.addEventListener("change", async () => {
    const { data: vs } = await supabase
      .from("vendor_stalls")
      .select("stall_id, stalls(stall_number, section_id, sections(name, monthly_fee))")
      .eq("vendor_id", vendorSelect.value)
      .is("released_at", null);
    stallSelect.innerHTML = (vs || []).map(row =>
      `<option value="${row.stall_id}" data-section="${row.stalls.section_id}">${row.stalls.stall_number} (${row.stalls.sections.name})</option>`
    ).join("") || `<option value="">No active stall for this vendor</option>`;
  });

  document.getElementById("recordPaymentBtn").addEventListener("click", async () => {
    const errBox = document.getElementById("paymentError");
    errBox.classList.add("hidden");
    const vendor_id = vendorSelect.value;
    const stall_id = stallSelect.value;
    const amount = document.getElementById("p_amount").value;
    const payment_month = document.getElementById("p_month").value;
    if (!vendor_id || !stall_id || !amount || !payment_month) {
      errBox.textContent = "All fields are required.";
      errBox.classList.remove("hidden");
      return;
    }
    const section_id = stallSelect.selectedOptions[0].dataset.section;
    const { error } = await supabase.from("payments").insert({
      vendor_id, stall_id, section_id, amount,
      payment_month, method: document.getElementById("p_method").value,
      recorded_by: session.user.id,
    });
    if (error) {
      errBox.textContent = error.message;
      errBox.classList.remove("hidden");
      return;
    }
    toast("Payment recorded.");
    renderManagerPayments();
  });
}

// =====================================================================
// VENDOR TABS
// =====================================================================
async function renderVendorProfile() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="card">
      <h3>My profile</h3>
      <table>
        <tr><td><strong>Name</strong></td><td>${profile.full_name}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${profile.phone}</td></tr>
        <tr><td><strong>Email</strong></td><td>${profile.email ?? "—"}</td></tr>
        <tr><td><strong>Vendor ID</strong></td><td><code>${vendorRow?.vendor_code ?? "—"}</code></td></tr>
        <tr><td><strong>Status</strong></td><td><span class="status-pill status-${vendorRow?.status}">${vendorRow?.status ?? "—"}</span></td></tr>
      </table>
    </div>
    <div class="card">
      <h3>Request a profile update</h3>
      <p class="card-sub">Changes need administrator approval before they take effect.</p>
      <label>New phone number</label>
      <input id="reqPhone" type="tel" placeholder="Leave blank to keep current" />
      <label>New email</label>
      <input id="reqEmail" type="email" placeholder="Leave blank to keep current" />
      <button class="btn btn-primary" id="submitUpdateBtn">Submit request</button>
    </div>`;

  document.getElementById("submitUpdateBtn").addEventListener("click", async () => {
    const changes = {};
    const newPhone = document.getElementById("reqPhone").value.trim();
    const newEmail = document.getElementById("reqEmail").value.trim();
    if (newPhone) changes.phone = newPhone;
    if (newEmail) changes.email = newEmail;
    if (!Object.keys(changes).length) { toast("Enter at least one change.", true); return; }

    const { error } = await supabase.from("profile_update_requests").insert({
      vendor_id: session.user.id,
      field_changes: changes,
    });
    if (error) { toast(error.message, true); return; }
    toast("Update request submitted.");
  });
}

async function renderVendorId() {
  const content = document.getElementById("content");
  const { data: market } = await supabase.from("markets").select("name").eq("id", vendorRow?.market_id).single();
  content.innerHTML = `
    <div class="card">
      <h3>My Vendor ID</h3>
      <p class="card-sub">Show this on request. It cannot be edited.</p>
      <div class="id-card">
        <div class="id-eyebrow">Rexba Market — Vendor ID</div>
        <div class="id-code">${vendorRow?.vendor_code ?? "—"}</div>
        <div class="id-name">${profile.full_name}</div>
        <div class="id-meta">
          Market: ${market?.name ?? "—"}<br/>
          Phone: ${profile.phone}<br/>
          Status: ${vendorRow?.status ?? "—"}
        </div>
      </div>
    </div>`;
}

async function renderVendorPayments() {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card"><h3>Payment history</h3><div id="vPayList">Loading...</div></div>`;

  const { data: payments, error } = await supabase
    .from("payments")
    .select("*, stalls(stall_number)")
    .eq("vendor_id", session.user.id)
    .order("payment_month", { ascending: false });

  const list = document.getElementById("vPayList");
  if (error) { list.innerHTML = `<div class="error-msg">${error.message}</div>`; return; }
  if (!payments.length) { list.innerHTML = `<div class="empty-state">No payments recorded yet.</div>`; return; }

  list.innerHTML = `
    <table>
      <thead><tr><th>Month</th><th>Stall</th><th>Amount</th><th>Method</th></tr></thead>
      <tbody>
        ${payments.map(p => `
          <tr><td>${p.payment_month}</td><td>${p.stalls?.stall_number ?? "—"}</td><td>UGX ${p.amount}</td><td>${p.method}</td></tr>
        `).join("")}
      </tbody>
    </table>`;
}

init();
