# Separate Estimation from Automated Optical Approval

The fitting-height estimator produces a Measurement Record and Measurement Confidence but does not itself approve production. A separate versioned Optical Approval Policy evaluates prescription, frame, lens, estimate, confidence, and merchant configuration, automatically approves only configurations inside its Mission-approved bounds, and routes all exceptions to manual Optical Review while recording policy version and Approval Basis.
