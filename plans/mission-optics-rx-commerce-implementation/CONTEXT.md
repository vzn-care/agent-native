# Mission Optics Rx Commerce

This context describes the people and commercial-optical concepts involved when Mission Optics adds prescription lenses to eyewear sold through a merchant's commerce store.

## Language

**Purchaser**:
The person or organization that places and pays for the commerce order. The Purchaser may or may not be the Prescription Subject.
_Avoid_: Customer, buyer, patient

**Prescription Subject**:
The person whose prescription and optical measurements are used for a particular pair of eyewear.
_Avoid_: Purchaser, customer, patient

**Mission Account**:
An authenticated identity that can obtain ongoing access to permitted Mission records. A Mission Account is not required to begin an Rx Configuration.
_Avoid_: Prescription Subject, purchaser account

**Guest Capability**:
A short-lived, store-bound and configuration-bound authorization created from a verified storefront context that permits an anonymous shopper to access only the specific incomplete Rx flow and protected upload operations it names.
_Avoid_: Shared guest account, browser session identity, merchant customer ID

**Subject Claim**:
A verified association that grants a Mission Account ongoing access to a Prescription Subject and the permitted records associated with that subject.
_Avoid_: Login, account creation

**Subject Authorization**:
A purpose-bound, revocable grant allowing a specific Mission workflow to use named Prescription Record or Measurement Record revisions for one Prescription Subject without transferring ownership to a merchant.
_Avoid_: Merchant membership, blanket consent, data copy

**Subject Representative**:
A person verified or authorized to manage permitted prescription information for a Prescription Subject who is not acting for themselves.
_Avoid_: Purchaser, account owner

**Subject Eligibility Policy**:
The versioned market and program rule defining which Prescription Subjects may use a particular Rx flow, including pilot age restrictions and any required representative or guardian authority.
_Avoid_: Account age, purchaser eligibility

**Rx Configuration**:
The customer-approved optical configuration for one physical pair of eyewear for exactly one Prescription Subject.
_Avoid_: Rx cart, prescription order

**Configuration Rebase**:
The application of an Rx Configuration's existing lens selections to a different frame, producing a new configuration revision after full compatibility and pricing evaluation.
_Avoid_: Frame swap, lens reselection

**Commerce Order Mirror**:
VZN Rx's current representation of the authoritative consumer order re-fetched from the merchant commerce platform. It may group multiple independently managed Rx Configurations and is not the OMS canonical operational order or evidence that manufacturing is approved.
_Avoid_: OMS order, production order, webhook payload

**Order Package Binding**:
VZN Rx's pair-level assignment of one Cart Execution Plan and its bound commerce lines, financial allocations, and revisions within a Commerce Order Mirror.
_Avoid_: Commerce Order Mirror, cart line, OMS Job

**OMS Canonical Order**:
The operational order accepted and normalized by OMS from one or more inbound order packages. OMS owns its order lines, submit snapshots, build specifications, jobs, fulfillment units, routing, QA, remakes, and shipment history.
_Avoid_: Shopify order, Commerce Order Mirror, Rx Configuration

**OMS Pair Handoff**:
The sanitized, content-digested VZN Rx command that submits exactly one released Shopify prescription pair to OMS with immutable references and a purpose-bound protected payload handle. One accepted handoff creates one quantity-one OMS order line and one initial OMS Job.
_Avoid_: Webhook body, prescription record, production snapshot

**Conditional Full Payment**:
Collection of the complete quoted frame and selected lens-package price through the commerce channel before prescription approval, with production explicitly conditional on later verification and any price difference handled through governed adjustment workflows.
_Avoid_: Deposit, Production Ready, guaranteed manufacturability

**Prescription Record**:
A versioned prescription issued for a Prescription Subject that may be reused while it remains valid and permitted for use.
_Avoid_: Prescription case, Rx configuration

**Prescription Verification**:
Independent confirmation that the values used in a Prescription Record accurately reflect an acceptable source under the applicable policy.
_Avoid_: Manual entry, optical approval

**Prescription Intake Method**:
The recorded channel by which Mission receives a prescription source: document upload, manual entry pending independent verification, later secure submission, or subject-authorized reuse of an existing verified Prescription Record.
_Avoid_: Prescription validity, Optical Approval

**Prescription Case**:
Mission's application and review of a specific Prescription Record revision for one Rx Configuration.
_Avoid_: Prescription record, commercial order, Rx cart

**Measurement Record**:
A versioned set of optical or fitting measurements with recorded provenance, capture date, confidence, and subject-level or pair-specific applicability.
_Avoid_: Prescription record, unqualified PD

**Measurement Confidence**:
The policy-defined assessment of whether a Measurement Record's method, provenance, consistency, age, and applicability are sufficient for a particular lens and frame context.
_Avoid_: Accuracy claim, verified flag

**Estimated Fitting Height**:
A frame-specific vertical fitting value derived from documented frame, lens-design, and subject wearing-position inputs by a versioned estimation method rather than direct measurement.
_Avoid_: PD-only fit, measured fitting height, waived measurement

**Production Ready**:
The state reached only when every required commercial, optical, inventory, integrity, and authorization condition for manufacturing has been satisfied.
_Avoid_: Paid, ordered, prescription received

**Optical Approval**:
The recorded determination by an authorized Optical Reviewer or approved automated policy that a specific set of prescription, measurement, frame, and lens revisions can produce approved manufacturing instructions.
_Avoid_: Production release, prescription received

**Optical Approval Policy**:
A versioned Mission-approved rule set that determines which configurations may receive automated Optical Approval and which require manual Optical Review.
_Avoid_: Estimation model, merchant optical rule

**Production Release**:
The Release Operator's final VZN Rx authorization to hand one pair to OMS after confirming Financial Clearance, commitment integrity, inventory readiness, approvals, and unresolved holds against the current revisions.
_Avoid_: Optical approval, paid status

**Approval Basis**:
The immutable set of prescription, measurement, frame, lens, Consumer Cart Commitment, OMS Brand Quote, order, financial, and instruction revisions to which an approval applies.
_Avoid_: Current data, latest version

**Change Proposal**:
A proposed post-checkout change to the agreed optical configuration or commercial amount that has no effect until the required party explicitly accepts it.
_Avoid_: Automatic upgrade, price correction, substitution

**Consumer Cart Commitment**:
VZN Rx's immutable, expiring commitment to the base shopper-facing commercial components, quantities, currency, and gross unit amounts for one Rx Configuration; Shopify remains authoritative for discounts, tax, shipping, payment, and refunds.
_Avoid_: OMS Brand Quote, cart total, payment authorization

**OMS Brand Quote**:
The OMS-controlled Mission-to-Brand wholesale authorization for a production order, including immutable catalog and price-book revisions, dispatch deposit, delivery remainder, adjustments, and receivable projection.
_Avoid_: Consumer Cart Commitment, Shopify payment, lab route cost

**Cart Authorization**:
A signed, expiring, self-contained materialization of one Consumer Cart Commitment that authorizes one commerce store to purchase its specific currency, component set, quantity, and locked gross unit amount without exposing prescription information.
_Avoid_: Prescription token, payment authorization, OMS Brand Quote

**Commerce Snapshot**:
The current authoritative representation of a cart, order, adjustment, or fulfillment retrieved from the order-owning commerce channel.
_Avoid_: Webhook payload, cached order

**Merchant Organization**:
The commerce-facing profile linking one framework-managed organization to one contracted OMS Brand. It may own multiple Store Connections and shared program templates, but it is not a second tenancy root or a replacement for OMS party roles and accounts.
_Avoid_: Shopify store, customer account, prescription-access group, independent tenant

**Pilot Program Owner**:
The assignable Mission role accountable for coordinating a pilot's product, engineering, optical, lab, support, merchant, readiness, and go-live work without automatically receiving protected optical access or approval authority.
_Avoid_: Hard-coded employee, project manager with implicit clinical access

**Store Connection**:
The authorized relationship between one merchant commerce store and Mission through which catalog mappings, cart authorization, order synchronization, and fulfillment updates occur.
_Avoid_: Merchant account, Shopify installation

**Store Certification**:
The recorded approval that a Store Connection passed required sandbox and live-theme transaction tests and that its catalog, validation, permissions, webhooks, fulfillment, and reconciliation controls match an approved capability fingerprint.
_Avoid_: App installation, OAuth success, merchant self-attestation

**Commerce Adapter**:
The platform-specific boundary that translates provider-neutral Mission commerce instructions and events to and from one order-owning commerce channel.
_Avoid_: Rx core, storefront integration

**Adapter Support Level**:
Mission's declared capability class for a Commerce Adapter: full native transaction enforcement, Mission-hosted checkout, or non-transactional limited support.
_Avoid_: Platform popularity, integration status

**Adapter Investment Gate**:
The commercial threshold for starting another production Commerce Adapter: three committed design partners on the same platform or one anchor merchant funding development and first-year support.
_Avoid_: Calendar roadmap, global platform popularity

**Hosted Configurator**:
The shared Mission-owned lens-selection and prescription experience embedded by commerce channels through a versioned integration contract.
_Avoid_: Shopify widget, merchant lens form

**Configurator Policy**:
The validated merchant-specific theme, content, offering, support, and permitted-flow settings for the Hosted Configurator, excluding changes to Mission-controlled semantics, safety, consent, validation, security, and accessibility requirements.
_Avoid_: Custom storefront code, merchant optical rules

**Cart Execution Plan**:
VZN Rx's provider-neutral instruction for creating the exact commercial component package associated with a Consumer Cart Commitment and Rx Configuration.
_Avoid_: Shopify cart, Cart Authorization

**Bound Commercial Component**:
A frame, lens, or service line in a Commerce Order Mirror that is assigned to an Rx Configuration and covered by its Cart Authorization and Consumer Cart Commitment.
_Avoid_: Ordinary order line, prescription data

**Lens Specification**:
A Mission-controlled definition of a manufacturable lens product and its technical constraints.
_Avoid_: Merchant product, lens listing

**Published Eligibility Envelope**:
The conservative, versioned prescription and configuration range exposed to customers for a particular frame, lens, lab, market, and merchant offering.
_Avoid_: Absolute manufacturing limit, marketing eligibility

**Verified Production Capability**:
The independently validated hard boundary within which a specific lab, lens, frame, and process combination may be manufactured, including capabilities intentionally not exposed in the Published Eligibility Envelope.
_Avoid_: Published range, manager judgment, undocumented lab capability

**Production Exception Approval**:
A case-specific, audited authorization by a role explicitly granted the exception capability to proceed outside the Published Eligibility Envelope but within Verified Production Capability, bound to exact input revisions and supporting evidence.
_Avoid_: Manufacturing-limit override, catalog expansion, standing exception

**Rx Exception Manager**:
An admissions, customer-service, or lab-management role explicitly granted authority to evaluate an out-of-envelope paid pair after its actual prescription and pair-specific production facts are available and either initiate an alternative flow or issue a Production Exception Approval.
_Avoid_: General administrator, automatic rules engine, unrestricted override role

**Merchant Lens Offering**:
A merchant-approved, customer-facing selection derived from a Lens Specification, including its retail presentation, price, market, and promotion policy.
_Avoid_: Lens specification, universal lens catalog

**Merchant Program Configuration**:
A versioned bundle of one merchant's lens offering, price book, promotion rules, deadlines, communications, delivery policy, and permitted automated approvals that moves through draft, validation, approval, and prospective publication.
_Avoid_: Mutable store settings, theme configuration

**Approved Market**:
A jurisdiction, currency, and fulfillment-destination combination that has passed Mission's legal, optical, tax, privacy, content, and operational review for a specific Merchant Program Configuration.
_Avoid_: Store market toggle, available shipping country

**Pilot Catalog Allowlist**:
The explicitly approved set of adult, in-stock commerce variants that may launch Mission's Rx flow after inventory, Frame Optical Profile, production, pricing, and Store Connection validation.
_Avoid_: Entire merchant catalog, storefront collection

**Promotion Policy**:
The merchant-specific rule declaring whether and how an approved discount may apply to a Merchant Lens Offering or service component.
_Avoid_: Storewide discount assumption, optical pricing rule

**Financial Adjustment Request**:
Mission's pair-specific recommendation for a refund, additional charge, or other commercial adjustment that the order-owning commerce channel must authorize and execute.
_Avoid_: Refund, Mission charge

**Replacement Credit**:
A one-time, non-transferable, non-cash credit tied to one committed prescription pair and usable only toward one replacement Rx Configuration, with any unapplied balance expiring at completion.
_Avoid_: Refund, store credit, warranty remake

**Responsibility Allocation**:
The recorded assignment of the cost of a replacement, remake, or adjustment to Mission, the merchant, a manufacturer or warranty source, the customer-policy budget, or manual review based on documented cause.
_Avoid_: Customer-facing blame, automatic Mission liability

**Financial Clearance**:
The recorded VZN Rx determination that a Production Release Case has an acceptable Shopify payment and financial-risk state under the applicable channel policy and has no unresolved financial hold preventing OMS handoff.
_Avoid_: Paid status, payment authorization

**Financial Risk Event**:
An authoritative payment reversal, fraud hold, chargeback, or comparable channel event that revokes Financial Clearance before Production Commitment or opens an audited financial incident after commitment.
_Avoid_: Optical rejection, automatic production cancellation

**Frame Reservation**:
A temporary SKU-level hold created after authoritative paid-order acceptance to protect inventory while the pair awaits optical readiness, configuration changes, or production release.
_Avoid_: Cart inventory, assigned physical frame, Frame Allocation

**Customer Action Deadline**:
The merchant-configurable deadline, bounded by Mission policy, for the authorized customer to provide required prescription information, measurements, approvals, or corrections for a paid pair.
_Avoid_: Automatic cancellation date, promised ship date

**Expired Customer Action Hold**:
The non-cancellation state entered when a Customer Action Deadline passes, suspending delivery estimates and requiring an explicit extension, substitution or backorder decision, or channel-executed cancellation and refund.
_Avoid_: Canceled order, abandoned cart, silent inventory release

**Customer Delivery Estimate**:
The customer-safe expected ship or delivery range derived from separate customer-action, production, QA, carrier, and conservative merchant-buffer components and recalculated when a relevant hold or authoritative estimate changes.
_Avoid_: Guaranteed delivery date, production SLA

**Production SLA Clock**:
The operational manufacturing interval that begins only at Production Commitment and excludes the earlier period awaiting prescription, payment clearance, frame readiness, approvals, or release.
_Avoid_: Time since checkout, customer delivery promise

**Frame Allocation**:
The assignment of one inspected Frame Unit to an Rx Configuration at Production Release, replacing its Frame Reservation and committing that physical unit to manufacturing.
_Avoid_: Cart reservation, SKU-level inventory hold, Shopify inventory

**Frame Unit**:
A uniquely identified physical frame tracked through inspection, production, quality assurance, shipment, and any remake investigation.
_Avoid_: Frame SKU, inventory quantity

**Frame Recovery**:
The identity-safe, traceable process by which a returned Frame Unit may re-enter usable inventory only after lens removal, documented inspection, disposition approval, and continued unit-history retention.
_Avoid_: Return restock, resale of prescription eyewear

**Frame Style**:
A merchant-defined frame model family that may contain multiple color and size variants.
_Avoid_: Frame variant, Frame Unit

**Frame Optical Profile**:
A versioned, approved description of a frame's geometry, lens shape, construction, materials, production constraints, provenance, and confidence for compatibility and fulfillment decisions.
_Avoid_: Product dimensions, digital twin, marketing model

**Frame Profile Correction**:
A new approved Frame Optical Profile revision that supersedes an earlier revision prospectively, triggers revalidation of every dependent case not yet at Production Commitment, and preserves the exact historical revision used by committed or completed Production Attempts.
_Avoid_: Editing a profile in place, silently updating production history

**Production Shape**:
The validated lens-boundary geometry authorized for manufacturing lenses for a particular frame revision.
_Avoid_: Product silhouette, rendering mesh, unverified trace

**Frame Equivalence Class**:
A Mission-validated set of Frame Units or variants that share the geometry, lens shape, size, material, and manufacturing characteristics required for safe substitution.
_Avoid_: Merchant substitution group, similar frame

**Production Release Case**:
VZN Rx's pre-production projection for one Rx Configuration and Order Package Binding. It records holds, approvals, Financial Clearance, and the current customer-safe OMS status without duplicating OMS production state.
_Avoid_: OMS Canonical Order, OMS Job, Commerce Order Mirror

**Production Attempt**:
The OMS-owned immutable record of one manufacturing run within an OMS Job, including the instructions, inputs, result, and disposition for that run.
_Avoid_: Mutable lab job, Production Release Case

**Production Instruction Package**:
The OMS-owned immutable, content-digested manufacturing command for one Production Attempt, bound to the exact approved configuration, restricted production snapshot, frame profile, Production Shape, lens specification, and authorization revisions. Its canonical semantics are lossless to the accepted DCS/OMA production contract; every adapter either preserves that representation or supplies an approved, conformance-tested mapping.
_Avoid_: Editable lab notes, current order data, generic work ticket

**Lab Acknowledgment**:
The lab's explicit, timestamped acceptance, rejection, revocation confirmation, or production-commitment response for a specific Production Instruction Package revision.
_Avoid_: Webhook delivery, assumed receipt, Mission timestamp

**Lab Adapter**:
The OMS-owned provider-specific boundary that translates canonical Production Instruction Packages and lab events to and from API, DCS/OMA, SFTP, file-exchange, or audited manual workflows without exposing lab-specific identifiers, statuses, or formats to VZN Rx.
_Avoid_: Lab business logic in VZN Rx, untracked portal work

**Manual Pilot Queue**:
The audited OMS-operated Lab Adapter used for the HyperLight pilot, where authorized operators receive immutable Production Instruction Packages and explicitly record acceptance, rejection, revocation, Production Commitment, QA, shipment, and remake events.
_Avoid_: Shared inbox, spreadsheet handoff, undocumented lab portal

**Quality Policy**:
The versioned Mission-controlled set of required inspections, measurement methods, tolerance bands, and disposition rules applied to a Production Attempt.
_Avoid_: Lab checklist, merchant preference, operator judgment

**Critical QA Limit**:
A numeric or categorical threshold designated centrally by Mission as non-overridable because exceeding it creates an unacceptable optical, safety, identity, damage, or manufacturing-integrity result.
_Avoid_: Default tolerance, manager-configurable limit, warning threshold

**System Administrator**:
A narrowly assigned Mission-level platform role authorized to publish any Quality Policy or Critical QA Limit change without secondary approval while remaining subject to immutable versioning, authentication, attribution, audit, notification, and prospective-effect rules.
_Avoid_: Merchant administrator, store owner, lab manager, anonymous superuser

**Administrative Break-Glass Publication**:
The unilateral System Administrator publication path requiring fresh step-up authentication, stated reason and evidence, impact preview, immutable audit, and immediate post-publication notification without any secondary approval or blocking review.
_Avoid_: Emergency approval request, silent superuser edit

**Step-Up Authentication**:
A fresh, higher-assurance identity challenge required immediately before a protected export, role change, approval, release, exception, administrative publication, or other high-consequence action.
_Avoid_: Active browser session, role authorization, human action approval

**QA Exception Approval**:
A case-specific authorization by a configured QA Manager to accept a result only within a Mission-defined noncritical tolerance band; it can never waive a Critical QA Limit.
_Avoid_: Ship-anyway approval, merchant exception

**Production Commitment**:
The recorded point in a Production Attempt after which cancellation can no longer guarantee that manufacturing will stop.
_Avoid_: Production start, shipment, cancellation deadline

**Delivery Policy**:
The merchant-selected rule determining whether OMS-managed pairs from a Commerce Order Mirror ship independently when ready or wait for the other Mission-managed pairs.
_Avoid_: Fulfillment status, shipping method

**Fulfillment Destination Snapshot**:
The versioned shipping destination re-fetched from the authoritative commerce channel and bound to a pair at order acceptance and again before label purchase.
_Avoid_: Customer profile address, prescription address, cached checkout address

**Optical Action Request**:
A customer-safe request for prescription information, measurements, correction, or approval that directs an authorized person to a secure Mission experience.
_Avoid_: Prescription email, merchant support message

**Optical Readiness Status**:
A customer-safe description of where a Prescription Case stands and which nonclinical action is required, without exposing prescription values, documents, measurements, or detailed review findings.
_Avoid_: Prescription status, clinical rejection reason

**Access Policy**:
Mission's centrally governed maximum permissions for protected prescription and optical information, within which approved role assignments and narrower merchant, jurisdiction, or operating-unit restrictions may be configured.
_Avoid_: Merchant permissions, unrestricted administrator role

**Prescription Authorization**:
Explicit permission from the Prescription Subject or Subject Representative to use a specific Prescription Record revision for a specific Rx Configuration.
_Avoid_: Merchant consent, prescription ownership transfer

**Retention Policy**:
The jurisdiction- and contract-aware rule defining which protected or operational records remain after access or reuse ends, why they remain, how access is restricted, and when they are deleted or de-identified.
_Avoid_: Account deletion, indefinite archive

**Learning Dataset**:
A governed, de-identified collection of technical configuration and outcome evidence used only for approved quality, safety, and model-improvement purposes across merchant programs.
_Avoid_: Analytics export, merchant benchmark data
