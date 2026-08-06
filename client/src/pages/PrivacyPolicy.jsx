import React from 'react';
import Footer from '../components/footer';

const PrivacyPolicy = () => {
  return (
    <div className="tw-min-h-screen tw-bg-gray-900 tw-text-gray-300 tw-font-jakarta">
      <div className="tw-max-w-4xl tw-mx-auto tw-px-6 tw-py-16">
        <h1 className="tw-text-4xl tw-font-bold tw-text-white tw-mb-4">Privacy Policy</h1>
        <p className="tw-text-sm tw-text-gray-400 tw-mb-10"><strong>Last Updated:</strong> {new Date().toLocaleDateString()}</p>
        
        <div className="tw-space-y-8">
          <section>
            <p className="tw-text-lg tw-leading-relaxed">
              Welcome to XCEED-NITJ.
              We are committed to protecting your right to privacy. This Privacy Policy governs your use of the XCEED website and mobile applications.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">1. Data Collection and Usage</h2>
            <p className="tw-text-base tw-leading-relaxed tw-mb-4">
              <strong>We do not collect, store, or process any personal data or information from our users.</strong>
            </p>
            <p className="tw-text-base tw-leading-relaxed">
              XCEED operates without requiring, gathering, or storing any personal details (such as names, email addresses, or phone numbers), authentication data, or usage metrics from its visitors. You can browse and use the platform with complete anonymity. We do not require account creation to access our public-facing information.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">2. Cookies and Tracking Technologies</h2>
            <p className="tw-text-base tw-leading-relaxed">
              We do not use cookies, web beacons, device identifiers, or any other tracking technologies to collect information about your browsing behavior or device usage.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">3. Third-Party Services</h2>
            <p className="tw-text-base tw-leading-relaxed">
              Our application does not integrate with third-party tracking, analytics, or advertising services. We do not share, sell, or rent any information to third parties, as we do not collect any information to begin with.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">4. Children's Privacy</h2>
            <p className="tw-text-base tw-leading-relaxed">
              Our services do not address anyone under the age of 13. We do not knowingly collect personally identifiable information from children under 13. Since our application does not collect any personal data, no data from children is ever obtained or stored.
            </p>
          </section>
          
          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">5. Security</h2>
            <p className="tw-text-base tw-leading-relaxed">
              We value your trust in using our application. While we do not collect any personal data, we strive to use commercially acceptable means of protecting our platform and ensuring a secure browsing experience for all users.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">6. Changes to This Privacy Policy</h2>
            <p className="tw-text-base tw-leading-relaxed">
              We may update our Privacy Policy from time to time. Thus, you are advised to review this page periodically for any changes. We will notify you of any changes by posting the new Privacy Policy on this page.
            </p>
          </section>

          <section>
            <h2 className="tw-text-2xl tw-font-semibold tw-text-cyan-400 tw-mb-4">7. Contact Us</h2>
            <p className="tw-text-base tw-leading-relaxed">
              If you have questions or comments about this notice or our privacy practices, you may email us at <strong>xceed@nitj.ac.in</strong>
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default PrivacyPolicy;
