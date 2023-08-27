import Image from 'next/image'
import styles from './page.module.css'

const imageStyle = {
  "margin-top": "100px",
}

export default function Home() {
  return (
    <main className={styles.main}>
      <div>
        <a
          href="https://github.com/InftyAI"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/logo.png"
            alt="InftyAI Logo"
            width={360}
            height={360}
            style={imageStyle}
            priority
          />
        </a>
      </div>

      <div className={styles.center}>
        <h1>
          Exploring the &nbsp;<code className={styles.code}>∞</code>&nbsp; possibilities of AI.
        </h1>
      </div>
    </main>
  )
}
