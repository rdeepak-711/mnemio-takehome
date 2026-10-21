# Dashboard brief (original, as written by Deepak, 22 Oct 2026)

Kept verbatim as the source. The scoped, buildable version is `spec/dashboard.md`.

---

# Skill: Build a Visually Engaging AI Email Automation Dashboard with Anime.js

## Role
Act as a senior frontend engineer, creative UI designer, and data-visualization specialist. Build a polished, interactive HTML dashboard that makes an AI-powered cold-email automation system visually understandable, engaging, and easy to explore.

Use **Anime.js** for purposeful animations and transitions. The result should feel like a premium SaaS analytics dashboard, not a generic admin template.

## Context
This dashboard visualizes an email automation engine managing 10,000 prospects through an initial email and up to three follow-ups. Contacts can reply, bounce, unsubscribe, or complete the sequence without responding.

The interface should help someone understand what happened during a campaign, how it progressed day by day, and the current state of every contact.

## 1. Visual Direction
- Create a premium, modern SaaS interface with excellent typography, spacing, contrast, and visual hierarchy.
- Use a dark command-center aesthetic with restrained accent colors, subtle gradients, fine borders, and tasteful glow effects.
- Make the interface visually rich without becoming cluttered.
- Use a consistent design system for colors, typography, spacing, cards, charts, and status indicators.
- Include responsive desktop, tablet, and mobile layouts.
- Avoid generic AI-generated dashboard aesthetics, excessive glassmorphism, meaningless animations, and oversized decorative elements.

## 2. Main Dashboard

### KPI cards
Display:
- Total contacts
- Emails sent
- Replies received
- Emails bounced
- Unsubscribes
- Contacts currently active
- Contacts deactivated
- Reply rate and bounce rate

Animate numerical values when the dashboard loads or when simulated data changes.

### Day-by-day campaign timeline
Build an interactive timeline showing campaign activity over multiple days.

For each day, visualize:
- Emails sent
- Follow-ups sent
- Replies received
- Bounces
- Unsubscribes
- Contacts entering or leaving the sequence

Use animated charts and visual markers to reveal campaign activity. Allow the user to select a day and inspect its details.

### Email activity visualization
Show how email volume changes over time using animated line charts, bar charts, or an area chart.

Include:
- Initial emails versus follow-ups
- Daily sending volume
- Replies and bounces over time
- A clear distinction between actual historical data and simulated future activity

Charts must communicate real values from the supplied dataset, not decorative random numbers.

### Contact journey visualization
Create a visually clear representation of the lifecycle:

New → Initial Email → Follow-up 1 → Follow-up 2 → Follow-up 3 → Deactivated

Show alternative terminal states:
- Replied
- Bounced
- Unsubscribed

Animate the movement of contacts through the sequence when running a simulation. Selecting a stage should reveal the number of contacts and their relevant details.

### Recent activity feed
Display a chronological feed of events such as:
- Email sent to a prospect
- Follow-up scheduled
- Reply received and classified
- Email bounced
- Unsubscribe received
- Contact deactivated

Each event should have a timestamp, contact identity, event type, and concise description. Use subtle entrance animations for new events.

### Contact explorer
Provide a searchable, filterable contact table with:
- Name
- Company
- Email
- Current sequence stage
- Last email sent
- Last reply
- Next scheduled action
- Contact status

Use colored status indicators and allow a row to open a contact-detail panel showing the complete email history and lifecycle.

## 3. AI Reply Classification
Include a dedicated visualization for the AI classifier.

Display categories such as:
- Interested
- Not interested
- Out of office
- Unsubscribe request
- Other or uncertain

Show category counts, percentage distribution, and example mock replies. For each reply, show the predicted category and a short explanation where available.

Make it clear that these are classifications produced by the system, not claims about an actual recipient unless supported by stored data.

## 4. Campaign Simulation Controls
Add a simulation control panel with:
- Play and pause
- Advance one day
- Advance seven days
- Reset simulation
- Current simulated date
- Simulation speed

When time advances, animate relevant metrics, charts, activity events, and contact-state transitions together.

Ensure that the visualization follows the underlying application state. Animation must never invent successful sends, replies, or state changes.

## 5. Anime.js Animation Guidelines
Use Anime.js to enhance comprehension, not merely to decorate.

Implement:
- Staggered entrance animations for KPI cards
- Smooth number transitions for changing metrics
- Chart drawing and bar-growth animations
- Timeline progression animations
- Subtle transitions between selected dates
- Contact-stage transition animations
- Activity-feed entrance animations
- Hover and focus feedback for interactive elements
- Coordinated transitions when advancing simulated time

Keep animations short, smooth, and purposeful. Avoid constantly moving backgrounds, distracting particles, excessive bouncing, and long delays before information becomes accessible.

Respect `prefers-reduced-motion`. Ensure that all important information remains available when animations are disabled.

Use the installed Anime.js version and its correct API. Do not invent library methods or assume a version without inspecting the project dependencies.

## 6. Data Integrity and Integration
The frontend is a visualization layer for the email automation backend.

- Inspect the existing project before making architectural decisions.
- Reuse existing frameworks, components, API clients, and styles where practical.
- If backend endpoints exist, integrate with them instead of duplicating business logic.
- If the backend is not ready, create a clearly separated mock-data provider with deterministic seed data.
- Keep API data, derived metrics, UI state, and animation logic separate.
- Show loading, empty, error, and stale-data states.
- Do not present fabricated metrics as production results.
- Make it easy to replace mock data with real API responses later.

## 7. Interaction and Usability
- Every visible button and interactive chart must have a meaningful action.
- Filters and date selections must update the displayed data.
- Tooltips should explain metrics and chart elements.
- Use clear labels and meaningful empty states.
- Provide accessible keyboard navigation and visible focus states.
- Avoid relying on color alone to distinguish statuses.
- Ensure that animations do not block interaction.

## 8. Suggested Layout
Use a persistent sidebar with:
- Overview
- Campaign Timeline
- Contact Journeys
- AI Classifier
- Contacts
- Activity Log

The overview page should contain KPI cards, campaign activity over time, contact lifecycle distribution, AI classification statistics, and a recent activity feed.

Keep detailed contact history and deeper analytics in their own views rather than squeezing everything into one screen.

## 9. Engineering Quality
- Build reusable components with clear responsibilities.
- Use semantic HTML and maintainable CSS.
- Keep animation code separate from business and data logic.
- Avoid unnecessary dependencies.
- Prevent overlapping animations and stale state updates.
- Clean up animations and event handlers when components unmount.
- Test the interface with realistic data volumes, including 10,000 contacts.
- Paginate or virtualize large contact lists instead of rendering everything at once.

## 10. Definition of Done
The finished dashboard must:
1. Look professionally designed and polished.
2. Make campaign activity understandable at a glance.
3. Show how metrics change across days.
4. Explain where contacts are in the sequence and why they stopped.
5. Make AI reply classifications easy to explore.
6. Support interactive time advancement using consistent data.
7. Use Anime.js purposefully and smoothly.
8. Work responsively and accessibly.
9. Integrate with the existing backend or a replaceable mock-data layer.
10. Run using the project's documented commands.

## Working Method
First inspect the repository, dependencies, existing frontend, and available backend endpoints. Then propose a concise implementation plan, identify the key screens and data structures, and implement the dashboard incrementally.

Prioritize a complete, coherent, working experience over decorative complexity. Do not rebuild the backend or change its architecture just to accommodate the frontend.

The final result should make a reviewer understand the email automation system within 30 seconds of opening the dashboard, while allowing them to explore its behavior in detail.
