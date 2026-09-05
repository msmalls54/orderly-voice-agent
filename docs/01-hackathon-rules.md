# Buildathon rules: confirmed, assumed, and unknown

Event: [The First Non-Tech Buildathon](https://luma.com/utyqfarn), September 4, 2026, AWS Builder Loft, San Francisco.

## Confirmed public requirements and facts

| Topic | Confirmed public information |
|---|---|
| Attendance | Free, in person, at AWS Builder Loft |
| Registration | Each attendee should complete both the [Luma registration](https://luma.com/utyqfarn) and [AWS Builder Loft registration](https://events.builder.aws.com/d/hcz0qt?utm_source=luma) |
| Teams | Prize copy explicitly refers to “every team member,” so teams are contemplated; no public team-size limit is stated |
| Build time | Luma currently publishes 2:00–4:30 PM; use 150 minutes as the maximum but be demo-ready by 4:00 |
| Showcase | Luma publishes 4:30–5:15 PM, followed by awards |
| Preparation | Attendees may bring an idea; no public page says ideas must be created onsite |
| Lovable | Described as the tool “to build your product” |
| ElevenLabs | Described as the tool “to add voice and audio” |
| Linkup | Described as the tool “to bring real-time web information” |
| Overall prize | Each winning-team member: 3 months of ElevenLabs Pro, 600,000 credits/month; project also receives $500 Linkup credits |
| ElevenLabs track | Each member of the best project built with ElevenLabs: 3 months of ElevenLabs Scale, 1.8 million credits/month |
| Bring | Fully charged laptop; an idea is optional |

## Not published

The current organizer, Luma, partner, and distribution pages do **not** publish answers to these questions:

- Must all code or the Lovable project be created during the build window?
- May teams bring an existing prototype or reuse code from another project?
- Are Codex and other coding agents allowed?
- Is using Lovable mandatory or merely encouraged?
- Is using all three build partners required for the overall prize?
- What is the judging rubric or weighting?
- How many people may be on a team?
- What is the presentation time limit and required submission format?
- Does “best project built with ElevenLabs” require an ElevenLabs-hosted agent, a minimum amount of usage, or a specific API?
- Must every team member have an ElevenLabs account before judging?
- Are participants eligible for both the overall prize and ElevenLabs track?
- Are projects judged only onsite, or must a link/repository/form be submitted?

Silence is not permission or prohibition. Codex is therefore **not publicly prohibited**, but it is not explicitly approved either.

## What is safe to prepare tonight

- Product idea, user story, pitch, architecture, schemas, threat model, test cases, mock data, and minute budget.
- Accounts, password-manager entries, local environment-variable names, and provider familiarity.
- Download and checksum verification of the official CLI without authenticating or placing an order.
- A written ElevenLabs agent prompt and webhook specification, held outside an event submission until the organizer answers the reuse question.
- A deterministic demo script and fallback recording plan.

## What should wait for the event or organizer answer

- The competition Lovable project.
- Competition source code if the organizer says implementation must start onsite.
- Copying code from the separate Grandpa Orders project.
- Publishing or submitting a prebuilt endpoint as if it were created during the build window.
- Redeeming onsite partner credits or relying on them before they are actually received.

## Organizer questions to ask at check-in

Ask these before 2:00 PM, in this order:

1. “Can we use existing code or a prebuilt backend, or must implementation start at 2:00?”
2. “Are Codex and other AI coding agents allowed?”
3. “Must the overall project use Lovable, ElevenLabs, and Linkup, or are they optional tools?”
4. “What are the judging criteria and demo time limit?”
5. “What exactly makes a submission eligible for the ElevenLabs prize?”
6. “Where and how do we submit, and is there a team-size limit?”

Record the organizer’s name, exact answer, and time in the decision log. If existing code is disallowed, build from the schemas and fixtures without copying prior source.

Every Scout Team cofounder who will attend should register separately in both systems rather than arrive as an unregistered guest.

## Conservative eligibility posture

The project folder transparently labels pre-event research and design. At the event, start a new implementation commit or Lovable project after the organizer answer. Keep the git/Lovable timestamps as the receipt. Do not claim the research packet was built onsite; it is planning material.
