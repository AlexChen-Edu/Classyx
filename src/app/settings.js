// Settings (app/settings.html): Children / Billing / Account / Legal tabs.
// Moved out of analytics.html so settings live in one place, reachable from
// the dashboard header, instead of being tied to a single child's page.
import { requireSession, getFamily, signOut } from './auth.js'
import {
  listChildren, updateChildGoal, updateChildName, updateChildGrade, deleteChild,
  uploadChildAvatar, getChildAvatarUrl, refreshChildCode, deactivateAccount,
} from './api.js'
import { $, $$, escapeHtml, setStatus, loading, initials, tintFor } from './ui.js'

const TAB_TITLES = { children: 'Children', billing: 'Billing', account: 'Account', legal: 'Legal' }
const PLAN_TO_BILLING_KEY = { student: 'single_child', family: 'family' }

const settingsTabs = $$('.settings-tab')
const settingsPanes = $$('.settings-pane')
const settingsTitle = $('#settings-title')
const childrenListEl = $('#children-list')

let children = []
let family = null
let activeChild = null // the child currently open in the Configure modal
let isSelf = false // role === 'self': Children tab is scoped to just their own profile

settingsTabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.settingsTab)))

function switchTab(name) {
  settingsTabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.settingsTab === name)))
  settingsPanes.forEach((p) => p.classList.toggle('hidden', p.dataset.settingsPane !== name))
  settingsTitle.textContent = TAB_TITLES[name] || 'Settings'
}

async function main() {
  const session = await requireSession()
  if (!session) return
  const role = session.user.user_metadata?.role
  if (role && role !== 'parent' && role !== 'self') {
    location.replace('/app/child.html')
    return
  }
  isSelf = role === 'self'
  if (isSelf) {
    TAB_TITLES.children = 'Profile'
    $('[data-settings-tab="children"]').textContent = 'Profile'
  }

  try {
    family = await getFamily()
  } catch (err) {
    if (err.deactivated) {
      await signOut()
      return
    }
    childrenListEl.innerHTML = `<div class="banner banner--error">Couldn't load settings: ${escapeHtml(err.message)}</div>`
    return
  }

  $('#account-email').textContent = session.user.email || '—'
  renderBillingPlans()
  await loadChildren()
}

// --- Children tab ------------------------------------------------------------
async function loadChildren() {
  try {
    children = await listChildren()
  } catch (err) {
    childrenListEl.innerHTML = `<div class="banner banner--error">${escapeHtml(err.message || 'Could not load children.')}</div>`
    return
  }
  renderChildren()
}

function renderChildren() {
  if (!children.length) {
    childrenListEl.innerHTML = `<p class="muted">No children yet. <a href="/app/add-child.html">Add a child</a> to get started.</p>`
    return
  }
  childrenListEl.innerHTML = children.map((c) => `
    <div class="settings-child-row" data-child-id="${c.id}">
      <div class="settings-child-row__avatar" style="background:${tintFor(c.name)}" data-avatar>${escapeHtml(initials(c.name))}</div>
      <div class="settings-child-row__info">
        <div class="settings-child-row__name">${escapeHtml(c.name)}</div>
        <div class="settings-child-row__grade">${c.grade ? `Grade ${escapeHtml(c.grade)}` : 'Learner'}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-configure type="button">Configure</button>
    </div>`).join('')

  childrenListEl.querySelectorAll('[data-avatar]').forEach(async (el) => {
    const childId = el.closest('[data-child-id]').dataset.childId
    const child = children.find((c) => c.id === childId)
    try {
      const url = await getChildAvatarUrl(child)
      if (url) el.innerHTML = `<img src="${url}" alt="${escapeHtml(child.name)}'s photo" />`
    } catch { /* keep the initials fallback */ }
  })

  childrenListEl.querySelectorAll('[data-configure]').forEach((btn) => {
    btn.addEventListener('click', () => openConfigure(btn.closest('[data-child-id]').dataset.childId))
  })
}

// --- Configure modal -----------------------------------------------------------
const configureOverlay = $('#configure-overlay')
const configureTitle = $('#configure-title')
const configureClose = $('#configure-close')
const configureAvatarEl = $('#configure-avatar')
const configureAvatarInput = $('#configure-avatar-input')
const configureAvatarStatus = $('#configure-avatar-status')
const configureNameInput = $('#configure-name-input')
const configureNameSaveBtn = $('#configure-name-save')
const configureNameStatus = $('#configure-name-status')
const configureGradeInput = $('#configure-grade-input')
const configureGradeSaveBtn = $('#configure-grade-save')
const configureGradeStatus = $('#configure-grade-status')
const configureGoalInput = $('#configure-goal-input')
const configureGoalSaveBtn = $('#configure-goal-save')
const configureGoalCurrent = $('#configure-goal-current')
const configureGoalStatus = $('#configure-goal-status')
const configureShowCodeBtn = $('#configure-show-code')
const configureCodeArea = $('#configure-code-area')
const configureCodePill = $('#configure-code-pill')
const configureRefreshCodeBtn = $('#configure-refresh-code')
const configureCodeStatus = $('#configure-code-status')
const configureRemoveBtn = $('#configure-remove-btn')
const configureRemoveStatus = $('#configure-remove-status')
const configureCodeField = $('#configure-code-field')
const configureRemoveSection = $('#configure-remove-section')

configureClose.addEventListener('click', closeConfigure)
configureOverlay.addEventListener('click', (e) => { if (e.target === configureOverlay) closeConfigure() })
configureAvatarInput.addEventListener('change', uploadAvatar)
configureNameSaveBtn.addEventListener('click', saveName)
configureGradeSaveBtn.addEventListener('click', saveGrade)
configureGoalSaveBtn.addEventListener('click', saveGoal)
configureShowCodeBtn.addEventListener('click', toggleCode)
configureRefreshCodeBtn.addEventListener('click', refreshCode)
configureRemoveBtn.addEventListener('click', removeChild)

function openConfigure(childId) {
  activeChild = children.find((c) => c.id === childId)
  if (!activeChild) return
  configureTitle.textContent = isSelf ? 'Edit your profile' : `Configure ${activeChild.name}`
  configureNameInput.value = activeChild.name
  configureGradeInput.value = activeChild.grade || ''
  const goal = activeChild.daily_goal_minutes ?? 30
  configureGoalInput.value = goal
  configureGoalCurrent.textContent = `Current goal: ${goal} min/day`
  configureRemoveBtn.textContent = `Remove ${activeChild.name}`
  configureCodeArea.classList.add('hidden')
  configureShowCodeBtn.textContent = 'Show code'
  // Self learners have no separate device to redeem a code on (their own
  // parent-authenticated session IS the access), and can't remove themselves
  // — that's what account deactivation is for — so both are parent-only UI.
  configureCodeField.classList.toggle('hidden', isSelf)
  configureRemoveSection.classList.toggle('hidden', isSelf)
  ;[configureAvatarStatus, configureNameStatus, configureGradeStatus, configureGoalStatus, configureCodeStatus, configureRemoveStatus]
    .forEach((el) => setStatus(el, ''))
  renderConfigureAvatar()
  configureOverlay.hidden = false
}

function closeConfigure() {
  configureOverlay.hidden = true
  activeChild = null
}

async function renderConfigureAvatar() {
  configureAvatarEl.textContent = initials(activeChild.name)
  configureAvatarEl.style.background = tintFor(activeChild.name)
  try {
    const url = await getChildAvatarUrl(activeChild)
    if (url) configureAvatarEl.innerHTML = `<img src="${url}" alt="${escapeHtml(activeChild.name)}'s photo" />`
  } catch { /* keep the initials fallback */ }
}

/** Crops to a centered square and re-encodes as PNG before upload — same approach as the old analytics.js settings panel. */
function fileToAvatarBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const img = new Image()
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.onload = () => { img.src = reader.result }
    img.onerror = () => reject(new Error('That file is not a valid image.'))
    img.onload = () => {
      const size = 256
      const side = Math.min(img.width, img.height)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size)
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))), 'image/png', 0.92)
    }
    reader.readAsDataURL(file)
  })
}

async function uploadAvatar() {
  const file = configureAvatarInput.files?.[0]
  if (!file) return
  setStatus(configureAvatarStatus, 'Uploading…')
  try {
    const blob = await fileToAvatarBlob(file)
    await uploadChildAvatar({ child: activeChild, blob })
    await renderConfigureAvatar()
    renderChildren()
    setStatus(configureAvatarStatus, 'Updated!', 'success')
  } catch (err) {
    setStatus(configureAvatarStatus, err.message || 'Could not upload that photo.', 'error')
  } finally {
    configureAvatarInput.value = ''
  }
}

async function saveName() {
  const name = configureNameInput.value.trim()
  if (!name) {
    setStatus(configureNameStatus, 'Enter a name.', 'error')
    return
  }
  setStatus(configureNameStatus, '')
  const restore = loading(configureNameSaveBtn, 'Saving…')
  try {
    await updateChildName(activeChild.id, name)
    activeChild.name = name
    configureTitle.textContent = `Configure ${name}`
    configureRemoveBtn.textContent = `Remove ${name}`
    restore()
    setStatus(configureNameStatus, 'Saved!', 'success')
    renderChildren()
  } catch (err) {
    restore()
    setStatus(configureNameStatus, err.message || 'Could not save. Try again.', 'error')
  }
}

async function saveGrade() {
  const grade = configureGradeInput.value
  setStatus(configureGradeStatus, '')
  const restore = loading(configureGradeSaveBtn, 'Saving…')
  try {
    await updateChildGrade(activeChild.id, grade)
    activeChild.grade = grade || null
    restore()
    setStatus(configureGradeStatus, 'Saved!', 'success')
    renderChildren()
  } catch (err) {
    restore()
    setStatus(configureGradeStatus, err.message || 'Could not save. Try again.', 'error')
  }
}

async function saveGoal() {
  const minutes = parseInt(configureGoalInput.value, 10)
  if (!Number.isFinite(minutes) || minutes < 1) {
    setStatus(configureGoalStatus, 'Enter a number of minutes greater than 0.', 'error')
    return
  }
  setStatus(configureGoalStatus, '')
  const restore = loading(configureGoalSaveBtn, 'Setting…')
  try {
    await updateChildGoal(activeChild.id, minutes)
    activeChild.daily_goal_minutes = minutes
    configureGoalCurrent.textContent = `Current goal: ${minutes} min/day`
    restore()
    setStatus(configureGoalStatus, 'Saved!', 'success')
  } catch (err) {
    restore()
    setStatus(configureGoalStatus, err.message || 'Could not save. Try again.', 'error')
  }
}

/** "Show code" generates + reveals a fresh code and flips to "Hide"; "Hide" just collapses the area, no new code generated. */
async function toggleCode() {
  if (configureShowCodeBtn.textContent === 'Hide') {
    configureCodeArea.classList.add('hidden')
    configureShowCodeBtn.textContent = 'Show code'
    return
  }
  setStatus(configureCodeStatus, '')
  const restore = loading(configureShowCodeBtn, 'Generating…')
  try {
    const code = await refreshChildCode(activeChild.id)
    restore()
    configureCodePill.textContent = code
    configureCodeArea.classList.remove('hidden')
    configureShowCodeBtn.textContent = 'Hide'
  } catch (err) {
    restore()
    setStatus(configureCodeStatus, err.message || 'Could not generate a code. Try again.', 'error')
  }
}

async function refreshCode() {
  setStatus(configureCodeStatus, '')
  configureRefreshCodeBtn.disabled = true
  try {
    const code = await refreshChildCode(activeChild.id)
    configureCodePill.textContent = code
  } catch (err) {
    setStatus(configureCodeStatus, err.message || 'Could not generate a code. Try again.', 'error')
  } finally {
    configureRefreshCodeBtn.disabled = false
  }
}

async function removeChild() {
  const name = activeChild.name
  if (!confirm(`This will permanently delete ${name}'s profile and all their study data. Are you sure?`)) return
  setStatus(configureRemoveStatus, '')
  configureRemoveBtn.disabled = true
  try {
    await deleteChild(activeChild.id)
    closeConfigure()
    await loadChildren()
  } catch (err) {
    configureRemoveBtn.disabled = false
    setStatus(configureRemoveStatus, err.message || 'Could not remove this profile. Try again.', 'error')
  }
}

// --- Billing tab ---------------------------------------------------------------
function renderBillingPlans() {
  const currentKey = PLAN_TO_BILLING_KEY[family?.plan] || 'free'
  $$('.billing-plans [data-plan]').forEach((card) => {
    const isCurrent = card.dataset.plan === currentKey
    card.classList.toggle('is-current', isCurrent)
    const btn = card.querySelector('.billing-upgrade-btn')
    if (!btn) return
    btn.textContent = isCurrent ? 'Current plan' : 'Upgrade'
    btn.disabled = isCurrent
  })
}

// --- Account tab -----------------------------------------------------------------
$('#signout-btn').addEventListener('click', signOut)

const deactivateBtn = $('#deactivate-btn')
const deactivateStatus = $('#deactivate-status')
const deactivateOverlay = $('#deactivate-overlay')
const deactivateConfirmBtn = $('#deactivate-confirm-btn')
const deactivateCancelBtn = $('#deactivate-cancel-btn')

deactivateBtn.addEventListener('click', () => { deactivateOverlay.hidden = false })
deactivateCancelBtn.addEventListener('click', () => { deactivateOverlay.hidden = true })
deactivateOverlay.addEventListener('click', (e) => { if (e.target === deactivateOverlay) deactivateOverlay.hidden = true })

deactivateConfirmBtn.addEventListener('click', async () => {
  setStatus(deactivateStatus, '')
  const restore = loading(deactivateConfirmBtn, 'Deactivating…')
  try {
    await deactivateAccount()
    await signOut()
  } catch (err) {
    restore()
    deactivateOverlay.hidden = true
    setStatus(deactivateStatus, err.message || 'Could not deactivate. Try again.', 'error')
  }
})

main()
