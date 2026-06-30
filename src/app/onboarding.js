// Short post-verification onboarding quiz for parent accounts. Collects a
// few preferences, recommends a plan, and stores the chosen plan on
// user_metadata before continuing to the dashboard. Never traps the user —
// the skip/close links default to the free plan.
import { supabase } from '../supabaseClient.js'
import { $, $$, setStatus, loading, friendlyMessage } from './ui.js'

const DASHBOARD = '/app/dashboard.html'
const SCREENS = ['1', '2', '3', '4', 'recommend']

const answers = { grade: '', challenges: [], kids: '', involvement: '' }
let currentIndex = 0

const progressFill = $('#progress-fill')
const screens = SCREENS.map((name) => $(`[data-screen="${name}"]`))

if (!supabase) {
  location.replace(DASHBOARD)
}

function showScreen(index) {
  currentIndex = index
  screens.forEach((el, i) => el.classList.toggle('is-active', i === index))
  // Progress only reflects the 4 questions, not the recommendation screen.
  const pct = Math.min(((index + 1) / 4) * 100, 100)
  progressFill.style.width = `${pct}%`
}

// --- Q1: grade ---------------------------------------------------------
const gradeSelect = $('#grade-select')
$('#q1-next').addEventListener('click', () => {
  answers.grade = gradeSelect.value
  showScreen(1)
})

// --- Q2: challenges (multi-select) --------------------------------------
$$('#challenge-chips .chip-option').forEach((chip) => {
  chip.setAttribute('aria-pressed', 'false')
  chip.addEventListener('click', () => {
    const value = chip.dataset.value
    chip.classList.toggle('is-selected')
    const selected = chip.classList.contains('is-selected')
    chip.setAttribute('aria-pressed', String(selected))
    if (selected) {
      answers.challenges.push(value)
    } else {
      answers.challenges = answers.challenges.filter((v) => v !== value)
    }
  })
})
$('#q2-back').addEventListener('click', () => showScreen(0))
$('#q2-next').addEventListener('click', () => showScreen(2))

// --- Q3: number of kids (single select) ---------------------------------
$$('#kids-options .select-option').forEach((opt) => {
  opt.setAttribute('aria-pressed', 'false')
  opt.addEventListener('click', () => {
    answers.kids = opt.dataset.value
    $$('#kids-options .select-option').forEach((o) => {
      o.classList.toggle('is-selected', o === opt)
      o.setAttribute('aria-pressed', String(o === opt))
    })
  })
})
$('#q3-back').addEventListener('click', () => showScreen(1))
$('#q3-next').addEventListener('click', () => showScreen(3))

// --- Q4: involvement (single select) ------------------------------------
$$('#involvement-options .select-option').forEach((opt) => {
  opt.setAttribute('aria-pressed', 'false')
  opt.addEventListener('click', () => {
    answers.involvement = opt.dataset.value
    $$('#involvement-options .select-option').forEach((o) => {
      o.classList.toggle('is-selected', o === opt)
      o.setAttribute('aria-pressed', String(o === opt))
    })
  })
})
$('#q4-back').addEventListener('click', () => showScreen(2))
$('#q4-next').addEventListener('click', () => {
  showRecommendation()
  showScreen(4)
})

// --- Recommendation -------------------------------------------------------
function recommendPlan() {
  if (answers.kids === 'multiple') {
    return { plan: 'family', reason: "Since you're supporting two or more kids, Family gives you everything at the best value." }
  }
  if (answers.involvement === 'detailed' || answers.challenges.length > 0) {
    return { plan: 'single_child', reason: "Since you want detailed insight into their progress, Single Child unlocks AI insights and smart alerts." }
  }
  return { plan: 'free', reason: "Free is a great way to get started and see how Classyx fits your family." }
}

function showRecommendation() {
  const { plan, reason } = recommendPlan()
  $('#recommend-reason').textContent = reason
  $$('.recommend-plans .plan').forEach((card) => {
    card.classList.toggle('plan--recommended', card.dataset.plan === plan)
  })
}

$$('.choose-plan-btn').forEach((btn) => {
  btn.addEventListener('click', () => completeOnboarding(btn.dataset.plan, btn))
})

const statusEl = $('#onboarding-status')

async function completeOnboarding(plan, btn) {
  const restore = loading(btn, 'Saving…')
  setStatus(statusEl, '')
  try {
    const { error } = await supabase.auth.updateUser({ data: { plan } })
    if (error) throw error
    location.replace(DASHBOARD)
  } catch (err) {
    setStatus(statusEl, friendlyMessage(err, 'Could not save your plan. Try again.'), 'error')
    restore()
  }
}

showScreen(0)
