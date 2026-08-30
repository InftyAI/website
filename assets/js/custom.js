// Put your custom JS code here

// Refresh the homepage star counts from /.netlify/functions/stars.
//
// The counts are already rendered at build time, so this only corrects them
// between rebuilds. Every failure path leaves the build-time values in place:
// running `hugo server` without `netlify dev` has no function to call, and a
// visitor may be offline.
//
// Cards are deliberately not re-sorted. This runs after first paint, so
// reordering would visibly shuffle them. The order therefore reflects the last
// deploy, and only looks wrong if two projects swap rank between deploys.
(function () {
  function format(count) {
    return count >= 1000 ? (count / 1000).toFixed(1) + "k" : String(count);
  }

  function refreshStars() {
    var badges = document.querySelectorAll(".feature-stars[data-repo]");
    if (!badges.length) {
      return;
    }

    fetch("/.netlify/functions/stars")
      .then(function (response) {
        if (!response.ok) {
          throw new Error("stars endpoint responded " + response.status);
        }
        return response.json();
      })
      .then(function (stars) {
        for (var i = 0; i < badges.length; i++) {
          var badge = badges[i];
          var count = stars[badge.dataset.repo.toLowerCase()];
          if (typeof count !== "number") {
            continue;
          }

          badge.querySelector("[data-stars-count]").textContent = format(count);
          badge.title = count + " stars on GitHub";
          // Reveals the badge on cards whose build-time lookup came back empty.
          badge.classList.remove("feature-stars-pending");
        }
      })
      .catch(function () {
        // Keep the build-time counts.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refreshStars, { once: true });
  } else {
    refreshStars();
  }
})();
